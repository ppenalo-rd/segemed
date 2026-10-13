const net = require('node:net');

async function startSmtpSink() {
  const messages = [];
  const waitingReaders = [];
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP\r\n');
    let buffer = '';
    let data = '';
    let receivingData = false;

    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer) {
        if (receivingData) {
          const terminator = buffer.indexOf('\r\n.\r\n');
          if (terminator < 0) {
            data += buffer;
            buffer = '';
            break;
          }
          data += buffer.slice(0, terminator);
          buffer = buffer.slice(terminator + 5);
          receivingData = false;
          const reader = waitingReaders.shift();
          if (reader) reader(data);
          else messages.push(data);
          data = '';
          socket.write('250 Message accepted\r\n');
          continue;
        }

        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) break;
        const line = buffer.slice(0, lineEnd);
        buffer = buffer.slice(lineEnd + 2);
        const command = line.split(' ')[0].toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250 localhost\r\n');
        else if (command === 'AUTH') socket.write('235 Authentication successful\r\n');
        else if (command === 'MAIL' || command === 'RCPT' || command === 'RSET' || command === 'NOOP') {
          socket.write('250 OK\r\n');
        } else if (command === 'DATA') {
          receivingData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 OK\r\n');
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    nextMessage() {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve) => waitingReaders.push(resolve));
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

module.exports = { startSmtpSink };
