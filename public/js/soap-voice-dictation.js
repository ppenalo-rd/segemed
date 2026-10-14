(function exposeSoapVoiceDictation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SIGEMEDSoapVoiceDictation = api;
    api.initialize(root);
  }
}(globalThis, () => {
  const VOICE_DICTATION_ENABLED = false;
  const LOCAL_SPEECH_LANGUAGES = ['es-VE', 'es-ES', 'es-MX'];

  function supportsLocalSpeechRecognition(SpeechRecognition) {
    return typeof SpeechRecognition === 'function'
      && typeof SpeechRecognition.available === 'function'
      && typeof SpeechRecognition.install === 'function'
      && SpeechRecognition.prototype
      && 'processLocally' in SpeechRecognition.prototype;
  }

  function insertDictationTranscript(value, transcript, selectionStart, selectionEnd) {
    const spokenText = typeof transcript === 'string' ? transcript.trim() : '';
    const text = typeof value === 'string' ? value : '';
    const requestedStart = Number.isInteger(selectionStart) ? selectionStart : text.length;
    const requestedEnd = Number.isInteger(selectionEnd) ? selectionEnd : requestedStart;
    const start = Math.max(0, Math.min(requestedStart, text.length));
    const end = Math.max(start, Math.min(requestedEnd, text.length));
    if (!spokenText) return { value: text, cursor: start };

    const before = text.slice(0, start);
    const after = text.slice(end);
    const prefix = before && !/\s$/.test(before) ? ' ' : '';
    const suffix = after && !/^\s/.test(after) ? ' ' : '';
    const inserted = `${prefix}${spokenText}${suffix}`;
    return {
      value: `${before}${inserted}${after}`,
      cursor: before.length + inserted.length,
    };
  }

  function configureLocalRecognition(recognition, language) {
    recognition.lang = language;
    recognition.processLocally = true;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    return recognition;
  }

  function manualEntryNotice(reason) {
    return `${reason} Puedes continuar escribiendo; no se usará reconocimiento remoto.`;
  }

  function initialize(windowObject) {
    if (!VOICE_DICTATION_ENABLED) return;
    const form = windowObject.document.getElementById('formSoap');
    if (!form) return;

    const SpeechRecognition = windowObject.SpeechRecognition
      || windowObject.webkitSpeechRecognition;
    const localRecognitionSupported = supportsLocalSpeechRecognition(SpeechRecognition);
    const state = {
      activeSession: null,
      controls: [],
      downloadableLanguage: null,
      language: null,
      languageCheck: null,
      requestSequence: 0,
      starting: false,
    };
    const fields = [...form.querySelectorAll('textarea:not([disabled]):not([readonly])')];

    function getFieldLabel(field) {
      const container = field.closest('.mb-3') || field.parentElement;
      const label = container && container.querySelector('label');
      return label ? label.textContent.trim() : field.name || field.id || 'campo clínico';
    }

    function setButtonState(button, status, message) {
      button.textContent = status === 'listening' ? '⏹ Detener dictado' : '🎤 Dictar';
      button.classList.toggle('btn-danger', status === 'listening');
      button.classList.toggle('btn-outline-secondary', status !== 'listening');
      button.setAttribute('aria-pressed', String(status === 'listening'));
      const statusElement = button.parentElement.querySelector('.soap-voice-status');
      statusElement.textContent = message;
    }

    async function getLocalLanguageAvailability() {
      if (state.language) return state.language;
      let downloadableLanguage = null;
      for (const language of LOCAL_SPEECH_LANGUAGES) {
        const availability = await SpeechRecognition.available({
          langs: [language],
          processLocally: true,
        });
        if (availability === 'available') {
          state.language = language;
          return language;
        }
        if (availability === 'downloadable' && !downloadableLanguage) downloadableLanguage = language;
      }
      state.downloadableLanguage = downloadableLanguage;
      return null;
    }

    function setControlsAvailability(message, canDictate) {
      state.controls.forEach(({ button, installButton, status }) => {
        button.disabled = !canDictate;
        installButton.hidden = canDictate || !state.downloadableLanguage;
        status.textContent = message;
        button.title = canDictate
          ? 'El audio se procesa localmente en el navegador.'
          : 'Dictado local no disponible; puedes escribir normalmente.';
      });
    }

    async function installLocalLanguage() {
      if (!state.downloadableLanguage) return;
      state.controls.forEach(({ installButton, status }) => {
        installButton.disabled = true;
        status.textContent = `Instalando el modelo local ${state.downloadableLanguage} en este dispositivo…`;
      });
      try {
        const language = state.downloadableLanguage;
        const installed = await SpeechRecognition.install({ langs: [language] });
        if (!installed) throw new Error('El navegador no pudo instalar el modelo local.');
        state.language = language;
        state.downloadableLanguage = null;
        setControlsAvailability('Modelo local disponible; el audio permanece en este dispositivo.', true);
      } catch (error) {
        state.controls.forEach(({ installButton, status }) => {
          installButton.disabled = false;
          status.textContent = manualEntryNotice(error.message || 'No se pudo instalar el modelo local.');
        });
        console.warn('No se pudo instalar el modelo local de dictado SOAP:', error.message);
      }
    }

    function finishSession(session, message) {
      if (state.activeSession !== session) return;
      state.activeSession = null;
      setButtonState(session.button, 'idle', message);
    }

    function stopActiveSession() {
      const session = state.activeSession;
      if (!session) return;
      session.stopRequested = true;
      try {
        session.recognition.stop();
      } catch (error) {
        finishSession(session, 'Dictado detenido.');
      }
    }

    async function startDictation(field, button) {
      if (state.activeSession) {
        if (state.activeSession.button === button) {
          stopActiveSession();
        } else {
          setButtonState(button, 'idle', 'Detén primero el dictado activo.');
        }
        return;
      }
      if (state.starting) {
        setButtonState(button, 'idle', 'Espera a que termine la comprobación del idioma local.');
        return;
      }
      if (!localRecognitionSupported) {
        setButtonState(
          button,
          'idle',
          manualEntryNotice('Dictado local no compatible en este navegador.')
        );
        return;
      }

      if (state.languageCheck) await state.languageCheck;
      if (!state.language) {
        setButtonState(
          button,
          'idle',
          manualEntryNotice('El reconocimiento local en español no está disponible en este dispositivo.')
        );
        return;
      }
      setButtonState(button, 'idle', 'Preparando el reconocimiento local…');
      state.starting = true;
      const requestSequence = ++state.requestSequence;
      try {
        const recognition = configureLocalRecognition(new SpeechRecognition(), state.language);

        const session = { recognition, button, field, stopRequested: false };
        state.activeSession = session;
        recognition.onresult = (event) => {
          const result = [...event.results].find((entry) => entry.isFinal);
          const transcript = result && result[0] && result[0].transcript;
          if (!transcript) return;
          const insertion = insertDictationTranscript(
            field.value,
            transcript,
            field.selectionStart,
            field.selectionEnd
          );
          field.value = insertion.value;
          field.setSelectionRange(insertion.cursor, insertion.cursor);
          field.dispatchEvent(new windowObject.Event('input', { bubbles: true }));
          setButtonState(button, 'listening', 'Texto reconocido localmente; puedes continuar dictando o detener.');
        };
        recognition.onerror = (event) => {
          const messages = {
            'not-allowed': 'Permiso de micrófono denegado. Verifica los permisos del navegador.',
            'service-not-allowed': 'El navegador no permitió el reconocimiento local.',
            'audio-capture': 'No se encontró un micrófono disponible.',
            'no-speech': 'No se detectó voz. Puedes volver a intentarlo.',
            'language-unavailable': 'El paquete local de español dejó de estar disponible.',
          };
          finishSession(session, messages[event.error] || 'Ocurrió un error en el dictado local.');
        };
        recognition.onend = () => {
          finishSession(
            session,
            session.stopRequested ? 'Dictado detenido.' : 'Dictado finalizado.'
          );
        };
        setButtonState(button, 'listening', 'Escuchando localmente…');
        recognition.start();
      } catch (error) {
        if (requestSequence !== state.requestSequence) return;
        state.activeSession = null;
        setButtonState(
          button,
          'idle',
          manualEntryNotice(error.message || 'No se pudo iniciar el dictado local.')
        );
        console.warn('No se pudo iniciar el reconocimiento local SOAP:', error.message);
      } finally {
        state.starting = false;
      }
    }

    fields.forEach((field) => {
      const container = windowObject.document.createElement('div');
      container.className = 'd-flex flex-column align-items-end gap-1 mb-2';
      const button = windowObject.document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-outline-secondary';
      button.textContent = '🎤 Dictar';
      button.disabled = !localRecognitionSupported;
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', `Dictar en ${getFieldLabel(field)}`);
      button.title = localRecognitionSupported
        ? 'Usar reconocimiento de voz local en este campo'
        : 'El navegador no ofrece reconocimiento local de voz';
      const status = windowObject.document.createElement('small');
      status.className = 'soap-voice-status text-muted text-end';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.textContent = localRecognitionSupported
        ? 'Comprobando disponibilidad de dictado local…'
        : 'Dictado local no compatible; puedes escribir normalmente.';
      const installButton = windowObject.document.createElement('button');
      installButton.type = 'button';
      installButton.className = 'btn btn-sm btn-link p-0';
      installButton.textContent = 'Instalar modelo de idioma local';
      installButton.title = 'Descarga únicamente el modelo local; no se envía audio a SIGEMED.';
      installButton.hidden = true;
      installButton.addEventListener('click', installLocalLanguage);
      button.addEventListener('click', () => startDictation(field, button));
      state.controls.push({ button, installButton, status });
      container.append(button, installButton, status);
      field.before(container);
    });

    if (localRecognitionSupported) {
      state.languageCheck = getLocalLanguageAvailability()
        .then((language) => {
          if (language) {
            setControlsAvailability('El audio se procesa localmente en el navegador.', true);
          } else if (state.downloadableLanguage) {
            setControlsAvailability(
              'El modelo local no está instalado. Puedes escribir o instalarlo para habilitar el dictado.',
              false
            );
          } else {
            setControlsAvailability(
              'Reconocimiento local no disponible; puedes continuar escribiendo normalmente.',
              false
            );
          }
        })
        .catch((error) => {
          setControlsAvailability(
            'No se pudo comprobar el dictado local; puedes continuar escribiendo normalmente.',
            false
          );
          console.warn('No se pudo comprobar disponibilidad de dictado SOAP:', error.message);
        });
    }

    const soapModal = windowObject.document.getElementById('modalNuevaNotaSoap');
    if (soapModal) {
      soapModal.addEventListener('hide.bs.modal', () => {
        state.requestSequence += 1;
      });
      soapModal.addEventListener('hidden.bs.modal', stopActiveSession);
    }
  }

  return {
    configureLocalRecognition,
    insertDictationTranscript,
    initialize,
    manualEntryNotice,
    supportsLocalSpeechRecognition,
    VOICE_DICTATION_ENABLED,
  };
}));
