const esl = require('esl');
const speech = require('@google-cloud/speech');
const fs = require('fs');
const path = require('path');
const net = require('net');

const GOOGLE_CREDS = '/opt/ivr-controller/gcp-key.json';
const SOUNDS_DIR = '/usr/share/freeswitch/sounds/ivr';
const ESL_PORT = 8084;
const ESL_INBOUND_PORT = 8021;
const ESL_PASSWORD = 'ClueCon';
const WAV_HEADER_SIZE = 44;
const POLL_INTERVAL_MS = 10;

process.env.GOOGLE_APPLICATION_CREDENTIALS = GOOGLE_CREDS;
const speechClient = new speech.SpeechClient();

const wordToDigit = {
  'one': '1', 'two': '2', 'three': '3', 'four': '4',
  'five': '5', 'six': '6', 'seven': '7', 'nine': '9',
  'repeat': '9', 'again': '9',
  'operations': '1', 'maintenance': '2', 'safety': '3',
  'fuel': '4', 'pay': '5', 'hr': '6', 'lumper': '7'
};

function mapTranscriptToDigit(transcript) {
  const lower = transcript.toLowerCase().trim();
  for (const [word, digit] of Object.entries(wordToDigit)) {
    if (lower.includes(word)) return digit;
  }
  if (/^[1-9]$/.test(lower)) return lower;
  return null;
}

// Send a command to FreeSWITCH via inbound ESL connection
function sendInboundCommand(command) {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let buffer = '';
    let authed = false;

    client.connect(ESL_INBOUND_PORT, '127.0.0.1', () => {});

    client.on('data', (data) => {
      buffer += data.toString();

      if (!authed && buffer.includes('auth/request')) {
        client.write('auth ' + ESL_PASSWORD + '\n\n');
        buffer = '';
        return;
      }

      if (!authed && buffer.includes('+OK accepted')) {
        authed = true;
        buffer = '';
        client.write('api ' + command + '\n\n');
        return;
      }

      if (authed && buffer.includes('Content-Type: api/response')) {
        const match = buffer.match(/Content-Length: (\d+)/);
        if (match) {
          const len = parseInt(match[1]);
          const bodyStart = buffer.indexOf('\n\n', buffer.indexOf('Content-Type: api/response')) + 2;
          if (buffer.length >= bodyStart + len) {
            const result = buffer.substring(bodyStart, bodyStart + len);
            client.destroy();
            resolve(result.trim());
          }
        }
      }
    });

    client.on('error', reject);
    setTimeout(() => { client.destroy(); resolve('timeout'); }, 3000);
  });
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
        if (!sttStream.destroyed) sttStream.write(buffer);
      }
    } catch(e) {}
  }, POLL_INTERVAL_MS);
  return { stop: () => clearInterval(interval) };
}

function startSTTStream(onDigit) {
  const stream = speechClient.streamingRecognize({
    config: {
      encoding: 'LINEAR16',
      sampleRateHertz: 8000,
      languageCode: 'en-US',
      model: 'phone_call',
      interimResults: true,
      singleUtterance: true,
      speechContexts: [{
        phrases: [
          'one', 'two', 'three', 'four', 'five',
          'six', 'seven', 'nine', 'operations',
          'maintenance', 'safety', 'fuel', 'pay',
          'HR', 'lumper', 'repeat'
        ],
        boost: 20
      }]
    }
  });

  stream.on('data', (data) => {
    if (data.results && data.results[0]) {
      const transcript = data.results[0].alternatives[0].transcript;
      const isFinal = data.results[0].isFinal;
      if (transcript && transcript.trim().length > 0) {
        console.log('STT ' + (isFinal ? 'FINAL' : 'interim') + ': ' + transcript);
        const digit = mapTranscriptToDigit(transcript);
        if (digit) {
          console.log('Digit detected:', digit);
          onDigit(digit);
        }
      }
    }
  });

  stream.on('error', (err) => console.error('STT error:', err.message));
  return stream;
}

async function handleCall(conn) {
  const uuid = conn.uuid();
  console.log('New call connected uuid:', uuid);

  const recFile = '/tmp/ivr_' + uuid + '.wav';
  let resultHandled = false;
  let sttStream = null;
  let fileStreamer = null;
  let attemptTimeout = null;

  function stopSTT() {
    try { if (fileStreamer) fileStreamer.stop(); } catch(e) {}
    try { if (sttStream && !sttStream.destroyed) sttStream.destroy(); } catch(e) {}
    if (attemptTimeout) clearTimeout(attemptTimeout);
    fileStreamer = null;
    sttStream = null;
  }

  async function safeExecute(app, arg, timeoutMs = 60000) {
    try {
      return await Promise.race([
        conn.execute(app, arg),
        new Promise(resolve => setTimeout(() => resolve(null), timeoutMs))
      ]);
    } catch(e) { return null; }
  }

async function setResultAndHangup(result) {
    if (resultHandled) return;
    resultHandled = true;
    const t0 = Date.now();
    console.log('Setting result:', result);
    stopSTT();

    sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
    const breakResult = await sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => 'err');
    console.log('Break:', breakResult, '+', Date.now() - t0, 'ms');

    const setResult = await sendInboundCommand('uuid_setvar ' + uuid + ' sip_bye_h_X-IVR-Result ' + result).catch(() => 'err');
    console.log('Setvar:', setResult, '+', Date.now() - t0, 'ms');

    const killResult = await sendInboundCommand('uuid_kill ' + uuid).catch(() => 'err');
    console.log('Kill:', killResult, '+', Date.now() - t0, 'ms');

    setTimeout(() => { try { fs.unlinkSync(recFile); } catch(e) {} }, 2000);
  }

  try {
    await conn.auto_cleanup();
    await conn.event_json('ALL');
    await safeExecute('answer');
    await safeExecute('sleep', '500');

    const menuVar = await conn.api('uuid_getvar ' + uuid + ' sip_h_X-IVR-Menu');
    const ivrMenu = (menuVar?.body || 'driver_line').toString().trim();
    const audioFile = path.join(SOUNDS_DIR, ivrMenu + '.wav');
    console.log('IVR Menu:', ivrMenu);

    const customerIdVar = await conn.api('uuid_getvar ' + uuid + ' sip_h_X-Customer-ID');
    const customerId = (customerIdVar?.body || '').toString().trim();
    const callGuidVar = await conn.api('uuid_getvar ' + uuid + ' sip_h_X-Call-GUID');
    const callGuid = (callGuidVar?.body || '').toString().trim();
    console.log('Customer-ID:', customerId, '| Call-GUID:', callGuid);	

    let attempts = 0;
    const maxAttempts = 3;

    conn.on('DTMF', async (evt) => {
      if (resultHandled) return;
      const digit = evt?.body?.['DTMF-Digit'];
      console.log('DTMF:', digit);
      if (digit && /^[1-79]$/.test(digit)) {
        if (digit === '9') {
          stopSTT();
          sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {});
          sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
          attempts--;
          setTimeout(runAttempt, 500);
        } else {
          await setResultAndHangup(digit);
        }
      }
    });

    var runAttempt = async () => {
      if (resultHandled) return;
      attempts++;
      if (attempts > maxAttempts) {
        await setResultAndHangup('0');
        return;
      }
      console.log('Attempt:', attempts);

      stopSTT();
      try { fs.unlinkSync(recFile); } catch(e) {}

      await conn.api('uuid_setvar ' + uuid + ' RECORD_READ_ONLY true');
      const recResult = await conn.api('uuid_record ' + uuid + ' start ' + recFile);
      console.log('Record:', recResult?.body?.toString().trim());

      setTimeout(() => {
        if (resultHandled) return;
        sttStream = startSTTStream(async (digit) => {
          if (resultHandled) return;
          if (digit === '9') {
            stopSTT();
            sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {});
            sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
            attempts--;
            setTimeout(runAttempt, 500);
          } else {
            await setResultAndHangup(digit);
          }
        });
        fileStreamer = streamFileToSTT(recFile, sttStream);
        console.log('STT streaming started');
      }, 100);

      safeExecute('playback', audioFile, 60000);
      console.log('Prompt playing...');

      attemptTimeout = setTimeout(async () => {
        if (!resultHandled) {
          console.log('Attempt', attempts, 'timeout');
          stopSTT();
          sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
          sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {});
          await safeExecute('playback', SOUNDS_DIR + '/timeout.wav', 10000);
          runAttempt();
        }
      }, 40000);
    };

    await runAttempt();

  } catch (err) {
    console.error('Call error:', err.message);
    stopSTT();
    try {
      await safeExecute('set', 'sip_bye_h_X-IVR-Result=0');
      await conn.hangup('NORMAL_CLEARING');
    } catch(e) {}
  }
}

const server = new esl.FreeSwitchServer({
  logger: { info: console.log, error: console.error, debug: () => {} }
});

server.on('connection', (conn) => {
  handleCall(conn).catch(console.error);
});

server.listen({ port: ESL_PORT })
  .then(() => console.log('IVR Controller listening on port ' + ESL_PORT))
  .catch(console.error);
