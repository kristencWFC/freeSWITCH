// Google STT V2 handler - prompt + speech/DTMF recognition + repeat handling
const speechV2 = require('@google-cloud/speech').v2;
const fs = require('fs');
const path = require('path');
const { sendInboundCommand } = require('../lib/freeswitch');

const SOUNDS_DIR = '/usr/share/freeswitch/sounds/ivr';
const WAV_HEADER_SIZE = 44;
const POLL_INTERVAL_MS = 10;
const MAX_STT_CHUNK = 25000;
const PROJECT_ID = 'memiccx';
const RECOGNIZER = 'projects/' + PROJECT_ID + '/locations/global/recognizers/_';

const speechClient = new speechV2.SpeechClient({
  keyFilename: '/opt/ivr-controller/gcp-key.json',
  projectId: PROJECT_ID,
});

const wordToDigit = {
  'one': '1', 'won': '1', 'juan': '1',
  'two': '2', 'too': '2', 'to': '2',
  'three': '3', 'tree': '3', 'free': '3',
  'four': '4', 'for': '4', 'fore': '4',
  'five': '5',
  'six': '6', 'text': '6', 'sex': '6', 'fix': '6', 'sicks': '6',
  'seven': '7',
  'nine': '9', 'mine': '9', 'line': '9', 'none': '9',
  'repeat': '9', 'again': '9',
  'operations': '1',
  'maintenance': '2',
  'safety': '3',
  'fuel': '4',
  'pay': '5',
  'hr': '6', 'h r': '6',
  'lumper': '7', 'lumber': '7'
};

function mapTranscriptToDigit(transcript) {
  const lower = transcript.toLowerCase().trim();
  for (const [word, digit] of Object.entries(wordToDigit)) {
    if (lower.includes(word)) return digit;
  }
  if (/^[1-9]$/.test(lower)) return lower;
  return null;
}

function streamFileToSTT(filePath, sttStream) {
  let position = WAV_HEADER_SIZE;
  const interval = setInterval(() => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > position) {
        const length = stat.size - position;
        const buffer = Buffer.alloc(length);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, length, position);
        fs.closeSync(fd);
        position += length;
        for (let off = 0; off < buffer.length; off += MAX_STT_CHUNK) {
          if (sttStream.destroyed) break;
          const chunk = buffer.slice(off, Math.min(off + MAX_STT_CHUNK, buffer.length));
          sttStream.write({ audio: chunk });
        }
      }
    } catch(e) {}
  }, POLL_INTERVAL_MS);
  return { stop: () => clearInterval(interval) };
}

function startSTTStream(logger, onDigit) {
  const stream = speechClient.streamingRecognize();

  stream.write({
    recognizer: RECOGNIZER,
    streamingConfig: {
      config: {
        explicitDecodingConfig: {
          encoding: 'LINEAR16',
          sampleRateHertz: 8000,
          audioChannelCount: 1,
        },
        languageCodes: ['en-US'],
        model: 'latest_short',
        adaptation: {
          phraseSets: [{
            inlinePhraseSet: {
              phrases: [
                { value: 'one', boost: 20 }, { value: 'two', boost: 20 },
                { value: 'three', boost: 20 }, { value: 'four', boost: 20 },
                { value: 'five', boost: 20 }, { value: 'six', boost: 20 },
                { value: 'seven', boost: 20 }, { value: 'nine', boost: 20 },
                { value: 'operations', boost: 20 }, { value: 'maintenance', boost: 20 },
                { value: 'safety', boost: 20 }, { value: 'fuel', boost: 20 },
                { value: 'pay', boost: 20 }, { value: 'HR', boost: 20 },
                { value: 'lumper', boost: 20 }, { value: 'repeat', boost: 20 }
              ]
            }
          }]
        }
      },
      streamingFeatures: {
        interimResults: true,
        enableVoiceActivityEvents: true,
        voiceActivityTimeout: {
          speechEndTimeout: { seconds: 0, nanos: 500000000 }
        }
      }
    }
  });

  stream.on('data', (data) => {
    if (data.results && data.results[0]) {
      const transcript = data.results[0].alternatives[0].transcript;
      const isFinal = data.results[0].isFinal;
      if (transcript && transcript.trim().length > 0) {
        logger.log('STT ' + (isFinal ? 'FINAL' : 'interim') + ':', transcript);
        const digit = mapTranscriptToDigit(transcript);
        if (digit) {
          logger.log('Digit detected:', digit);
          onDigit(digit);
        }
      }
    }
  });

  stream.on('error', (err) => logger.error('STT error:', err.message));
  return stream;
}

async function safeExecute(conn, app, arg, timeoutMs = 60000) {
  try {
    return await Promise.race([
      conn.execute(app, arg),
      new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
    ]);
  } catch(e) { return null; }
}

// Main handler entry point. Returns { result, extraHeaders }.
async function handle(conn, uuid, context) {
  const { logger, solutionConfig } = context;
  const ivrMenu = solutionConfig || 'driver_line';
  const audioFile = path.join(SOUNDS_DIR, ivrMenu + '.wav');
  logger.log('IVR Menu:', ivrMenu);

  const recFile = '/tmp/ivr_' + uuid + '.wav';
  let resolved = false;
  let sttStream = null;
  let fileStreamer = null;
  let attemptTimeout = null;
  let attempts = 0;
  const maxAttempts = 3;

  function stopSTT() {
    try { if (fileStreamer) fileStreamer.stop(); } catch(e) {}
    try { if (sttStream && !sttStream.destroyed) sttStream.destroy(); } catch(e) {}
    if (attemptTimeout) clearTimeout(attemptTimeout);
    fileStreamer = null;
    sttStream = null;
  }

  return new Promise((finalResolve) => {
    async function resolveOnce(value) {
      if (resolved) return;
      resolved = true;
      logger.log('Handler resolving with result:', value);
      stopSTT();
      // Stop recording and break playback so caller hears no more audio
      await Promise.all([
        sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {}),
        sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {})
      ]);
      setTimeout(() => { try { fs.unlinkSync(recFile); } catch(e) {} }, 2000);
      finalResolve({ result: value, extraHeaders: {} });
    }

    conn.on('DTMF', async (evt) => {
      if (resolved) return;
      const digit = evt && evt.body ? evt.body['DTMF-Digit'] : null;
      logger.log('DTMF:', digit);
      if (digit && /^[1-79]$/.test(digit)) {
        if (digit === '9') {
          stopSTT();
          sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {});
          sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
          attempts--;
          setTimeout(runAttempt, 500);
        } else {
          await resolveOnce(digit);
        }
      }
    });

    const runAttempt = async () => {
      if (resolved) return;
      attempts++;
      if (attempts > maxAttempts) {
        await resolveOnce('0');
        return;
      }
      logger.log('Attempt:', attempts);

      stopSTT();
      try { fs.unlinkSync(recFile); } catch(e) {}

      const setvarResult = await sendInboundCommand('uuid_setvar ' + uuid + ' RECORD_READ_ONLY true').catch(() => 'err');
      if (setvarResult === 'err' || (setvarResult && setvarResult.includes('ERR'))) {
        logger.log('Channel no longer exists, aborting attempt');
        await resolveOnce('0');
        return;
      }
      const recResult = await sendInboundCommand('uuid_record ' + uuid + ' start ' + recFile).catch(() => 'err');
      logger.log('Record:', recResult);

      setTimeout(() => {
        if (resolved) return;
        sttStream = startSTTStream(logger, async (digit) => {
          if (resolved) return;
          if (digit === '9') {
            stopSTT();
            sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {});
            sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
            attempts--;
            setTimeout(runAttempt, 500);
          } else {
            await resolveOnce(digit);
          }
        });
        fileStreamer = streamFileToSTT(recFile, sttStream);
        logger.log('STT streaming started');
      }, 100);

      safeExecute(conn, 'playback', audioFile, 60000);
      logger.log('Prompt playing...');

      attemptTimeout = setTimeout(async () => {
        if (resolved) return;
        logger.log('Attempt', attempts, 'timeout');
        stopSTT();
        sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
        sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {});
        await safeExecute(conn, 'playback', SOUNDS_DIR + '/timeout.wav', 10000);
        runAttempt();
      }, 40000);
    };

    (async () => {
      await safeExecute(conn, 'answer');
      await safeExecute(conn, 'sleep', '500');
      await runAttempt();
    })();
  });
}

module.exports = { name: 'googlestt', handle };
