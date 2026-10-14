const test = require('node:test');
const assert = require('node:assert/strict');
const {
  configureLocalRecognition,
  insertDictationTranscript,
  manualEntryNotice,
  supportsLocalSpeechRecognition,
  VOICE_DICTATION_ENABLED,
} = require('../public/js/soap-voice-dictation');

test('mantiene deshabilitado el dictado por voz en esta versión', () => {
  assert.equal(VOICE_DICTATION_ENABLED, false);
  assert.doesNotThrow(() => require('../public/js/soap-voice-dictation').initialize(null));
});

test('inserta la transcripción en el cursor y conserva el resto del texto', () => {
  assert.deepEqual(insertDictationTranscript('Síntoma final', 'dolor abdominal', 7, 7), {
    value: 'Síntoma dolor abdominal final',
    cursor: 23,
  });
  assert.deepEqual(insertDictationTranscript('A B C', 'nuevo dato', 2, 3), {
    value: 'A nuevo dato C',
    cursor: 12,
  });
});

test('normaliza espacios de la transcripción y deja intacto el campo si no hay voz', () => {
  assert.deepEqual(insertDictationTranscript('Hallazgo.', '  fiebre  ', 9, 9), {
    value: 'Hallazgo. fiebre',
    cursor: 16,
  });
  assert.deepEqual(insertDictationTranscript('Texto clínico', '  ', 4, 4), {
    value: 'Texto clínico',
    cursor: 4,
  });
});

test('solo acepta constructores con soporte explícito para reconocimiento local', () => {
  class LocalSpeechRecognition {}
  LocalSpeechRecognition.prototype.processLocally = false;
  LocalSpeechRecognition.available = async () => 'available';
  LocalSpeechRecognition.install = async () => true;

  class RemoteOnlySpeechRecognition {}

  assert.equal(supportsLocalSpeechRecognition(LocalSpeechRecognition), true);
  assert.equal(supportsLocalSpeechRecognition(RemoteOnlySpeechRecognition), false);
  assert.equal(supportsLocalSpeechRecognition(undefined), false);
});

test('configura el reconocimiento para español y exige procesamiento local', () => {
  const recognition = configureLocalRecognition({}, 'es-VE');

  assert.deepEqual(recognition, {
    lang: 'es-VE',
    processLocally: true,
    continuous: false,
    interimResults: false,
    maxAlternatives: 1,
  });
});

test('ofrece continuar por entrada manual sin recurrir a reconocimiento remoto', () => {
  assert.match(
    manualEntryNotice('No hay un paquete local de español.'),
    /Puedes continuar escribiendo/
  );
  assert.match(
    manualEntryNotice('No hay un paquete local de español.'),
    /no se usará reconocimiento remoto/
  );
});
