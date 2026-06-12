const esl = require('esl');
const http = require('http');
const crypto = require('crypto');
const config = require('./config.json');
const speech = require('@google-cloud/speech');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
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
const speechV2 = require('@google-cloud/speech').v2;
const speechClient = new speechV2.SpeechClient();
const PROJECT_ID = 'memiccx';
const RECOGNIZER = `projects/${PROJECT_ID}/locations/global/recognizers/_`;

const wordToDigit = {
  // Digit words
  'one': '1', 'won': '1', 'juan': '1',
  'two': '2', 'too': '2', 'to': '2',
  'three': '3', 'tree': '3', 'free': '3',
  'four': '4', 'for': '4', 'fore': '4',
  'five': '5',
  'six': '6', 'text': '6', 'sex': '6', 'fix': '6', 'sicks': '6',
  'seven': '7',
  'nine': '9', 'mine': '9', 'line': '9', 'none': '9',
  'repeat': '9', 'again': '9',
  // Menu keywords
  'operations': '1',
  'maintenance': '2',
  'safety': '3',
  'fuel': '4',
  'pay': '5',
  'hr': '6', 'h r': '6', 'h. r.': '6', 'h.r.': '6',
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

const MAX_STT_CHUNK = 25000;  // V2 limit is 25600, leave headroom

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
        // Split into chunks under the V2 limit
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

function startDeepgramStream(onDigit, log, logErr) {
  const dgConfig = (typeof config !== 'undefined' && config && config.deepgram) || {};
  const apiKey = dgConfig.apiKey;
  if (!apiKey) {
    logErr('Deepgram: no apiKey in config.json (config.deepgram.apiKey)');
    return { write: () => {}, destroy: () => {}, get destroyed() { return true; } };
  }

  const dg = createClient(apiKey);
  const live = dg.listen.live({
    model: dgConfig.model || 'nova-3',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: 8000,
    channels: 1,
    interim_results: true,
    endpointing: dgConfig.endpointing || 300,
    smart_format: false,
    punctuate: false,
    keyterm: [
      'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'nine',
      'operations', 'maintenance', 'safety', 'fuel', 'pay', 'HR', 'lumper', 'repeat'
    ],
  });

  let ready = false;
  let _destroyed = false;
  let _chunkCount = 0;
  const pendingChunks = [];

  live.on(LiveTranscriptionEvents.Open, () => {
    log('Deepgram stream open (model=' + (dgConfig.model || 'nova-3') + ')');
    ready = true;
    while (pendingChunks.length > 0) {
      const chunk = pendingChunks.shift();
      try { live.send(chunk); } catch (e) {}
    }
  });

  live.on(LiveTranscriptionEvents.Transcript, (data) => {
    try {
      const alt = data && data.channel && data.channel.alternatives && data.channel.alternatives[0];
      const transcript = alt && alt.transcript;
      if (!transcript || !transcript.trim()) return;
      const isFinal = !!data.is_final;
      log('Deepgram ' + (isFinal ? 'FINAL' : 'interim') + ': ' + transcript);
      const digit = mapTranscriptToDigit(transcript);
      if (digit) {
        log('Digit detected:', digit);
        onDigit(digit);
      }
    } catch (e) { logErr('Deepgram transcript handler error:', e.message); }
  });

  live.on(LiveTranscriptionEvents.Error, (err) => {
    logErr('Deepgram error:', (err && err.message) || String(err));
  });

  live.on(LiveTranscriptionEvents.Close, () => {
    log('Deepgram stream closed');
    ready = false;
  });

  return {
    write(chunk) {
      if (_destroyed) return;
      // Unwrap Google STT v2 envelope ({audio: Buffer}) - Deepgram wants raw audio bytes
      let buf = chunk;
      if (chunk && typeof chunk === 'object' && !Buffer.isBuffer(chunk) && chunk.audio) {
        buf = chunk.audio;
      }
      if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) return;
      _chunkCount++;
      if (_chunkCount === 1 || _chunkCount % 50 === 0) {
        log('Deepgram: sent ' + _chunkCount + ' chunks (last=' + buf.length + ' bytes)');
      }
      if (ready) {
        try { live.send(buf); } catch (e) {}
      } else {
        pendingChunks.push(buf);
      }
    },
    destroy() {
      _destroyed = true;
      try { live.finish(); } catch (e) {}
    },
    get destroyed() { return _destroyed; },
  };
}

function startSTTStream(onDigit, log, logErr) {
  const stream = speechClient._streamingRecognize ? speechClient._streamingRecognize() : speechClient.streamingRecognize();

  // First message: config
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
    log('STT raw event:', JSON.stringify(data).substring(0, 300));
    if (data.results && data.results[0]) {
      const transcript = data.results[0].alternatives[0].transcript;
      const isFinal = data.results[0].isFinal;
      if (transcript && transcript.trim().length > 0) {
        log('STT ' + (isFinal ? 'FINAL' : 'interim') + ': ' + transcript);
        const digit = mapTranscriptToDigit(transcript);
        if (digit) {
          log('Digit detected:', digit);
          onDigit(digit);
        }
      }
    }
  });

  stream.on('error', (err) => logErr('STT error:', err.message));
  return stream;
}

async function handleCall(conn) {
  const uuid = conn.uuid();
  // TEMPORARY DEBUG: log every event emitted on this connection
  const _origEmit = conn.emit.bind(conn);
  conn.emit = function(name, ...args) {
    if (typeof name === 'string'
        && !name.startsWith('socket.')
        && !name.startsWith('freeswitch_command_reply')
        && !name.startsWith('CHANNEL_EXECUTE_COMPLETE')
        && name !== 'data') {
      const digitMaybe = args[0]?.body?.['DTMF-Digit'];
      console.log('[EMIT]', name, digitMaybe ? '(digit=' + digitMaybe + ')' : '');
    }
    return _origEmit(name, ...args);
  };
  let logPrefix = '[' + uuid.substring(0,8) + ']';
  const log = (...args) => console.log(logPrefix, ...args);
  const logErr = (...args) => console.error(logPrefix, ...args);
  log('New call connected uuid:', uuid);

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
    log('Setting result:', result);
    stopSTT();

    sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
    const breakResult = await sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => 'err');
    log('Break:', breakResult, '+', Date.now() - t0, 'ms');

    const setResult = await sendInboundCommand('uuid_setvar ' + uuid + ' sip_bye_h_X-IVR-Result ' + result).catch(() => 'err');
    log('Setvar:', setResult, '+', Date.now() - t0, 'ms');

    const killResult = await sendInboundCommand('uuid_kill ' + uuid).catch(() => 'err');
    log('Kill:', killResult, '+', Date.now() - t0, 'ms');

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
    log('IVR Menu:', ivrMenu);

    const customerIdVar = await conn.api('uuid_getvar ' + uuid + ' sip_h_X-Customer-ID');
    const customerId = (customerIdVar?.body || '').toString().trim();
    const callGuidVar = await conn.api('uuid_getvar ' + uuid + ' sip_h_X-Call-GUID');
    const callGuid = (callGuidVar?.body || '').toString().trim();
    logPrefix = '[' + (callGuid || uuid.substring(0,8)) + ']';

    const solutionVar = await conn.api('uuid_getvar ' + uuid + ' sip_h_X-Solution-Name');
    const solutionName = (solutionVar?.body || '').toString().trim() || 'googlestt';

    log('Solution:', solutionName);
    log('Customer-ID:', customerId, '| Call-GUID:', callGuid);

    // Dispatch to ElevenLabs handler if requested
    if (solutionName === 'elevenlabs') {
      const elResult = await handleElevenLabs(conn, uuid, { log, logErr, callGuid, customerId });
      const result = (elResult && elResult.result) || '0';
      await sendInboundCommand('uuid_setvar ' + uuid + ' sip_bye_h_X-IVR-Result ' + result).catch(() => {});
      for (const [n, v] of Object.entries((elResult && elResult.extraHeaders) || {})) {
        if (v) await sendInboundCommand('uuid_setvar ' + uuid + ' sip_bye_h_' + n + ' ' + v).catch(() => {});
      }
      if (customerId) await sendInboundCommand('uuid_setvar ' + uuid + ' sip_bye_h_X-Customer-ID ' + customerId).catch(() => {});
      if (callGuid) await sendInboundCommand('uuid_setvar ' + uuid + ' sip_bye_h_X-Call-GUID ' + callGuid).catch(() => {});
      await new Promise(r => setTimeout(r, 200));
      const killResult = await sendInboundCommand('uuid_kill ' + uuid).catch(() => 'err');
      log('Kill:', killResult);
      return;
    }	

    // STT engine selector - 'deepgram' or default ('googlestt')
    const sttFactory = (solutionName === 'deepgram') ? startDeepgramStream : startSTTStream;
    log('STT engine:', (solutionName === 'deepgram') ? 'deepgram (Nova-3)' : 'googlestt (latest_short)');

    let attempts = 0;
    const maxAttempts = 3;

    conn.on('DTMF', async (evt) => {
      if (resultHandled) return;
      const digit = evt?.body?.['DTMF-Digit'];
      log('DTMF:', digit);
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
      log('Attempt:', attempts);

      stopSTT();
      try { fs.unlinkSync(recFile); } catch(e) {}

      // Use inbound ESL so a closed outbound socket can't crash us
      const setvarResult = await sendInboundCommand('uuid_setvar ' + uuid + ' RECORD_READ_ONLY true').catch(() => 'err');
      if (setvarResult === 'err' || (setvarResult && setvarResult.includes('ERR'))) {
        log('Channel no longer exists, aborting attempt');
        resultHandled = true;
        return;
      }
      const recResult = await sendInboundCommand('uuid_record ' + uuid + ' start ' + recFile).catch(() => 'err');
      console.log('Record:', recResult);

      setTimeout(() => {
        if (resultHandled) return;
        sttStream = sttFactory(async (digit) => {
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
        }, log, logErr);
        fileStreamer = streamFileToSTT(recFile, sttStream);
        log('STT streaming started');
      }, 100);

      // playback_terminators must be set before playback so DTMF interrupts the prompt
      // and the DTMF event fires in real time (instead of being queued until playback ends).
      sendInboundCommand('uuid_setvar ' + uuid + ' playback_terminators 1234567890').catch(() => {});
      safeExecute('playback', audioFile, 60000);
      log('Prompt playing...');

      attemptTimeout = setTimeout(async () => {
        if (!resultHandled) {
          log('Attempt', attempts, 'timeout');
          stopSTT();
          sendInboundCommand('uuid_record ' + uuid + ' stop ' + recFile).catch(() => {});
          sendInboundCommand('uuid_break ' + uuid + ' all').catch(() => {});
          sendInboundCommand('uuid_setvar ' + uuid + ' playback_terminators 1234567890').catch(() => {});
          await safeExecute('playback', SOUNDS_DIR + '/timeout.wav', 10000);
          runAttempt();
        }
      }, 40000);
    };

    await runAttempt();

  } catch (err) {
    logErr('Call error:', err.message);
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

// =====================================================
// ElevenLabs handler + HTTP webhook listener
// =====================================================
const pendingWebhooks = new Map();


function verifyElevenLabsSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(',');
  let timestamp = null;
  let signature = null;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('t=')) timestamp = trimmed.substring(2);
    if (trimmed.startsWith('v0=')) signature = trimmed.substring(3);
  }
  if (!timestamp || !signature) return false;
  // Reject timestamps older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    console.error('[webhook] Signature timestamp out of range:', timestamp);
    return false;
  }
  const payload = timestamp + '.' + rawBody;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch (e) {
    return false;
  }
}

const webhookServer = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405); res.end('Method not allowed'); return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const secret = (config.elevenlabs && config.elevenlabs.webhookSecret) || null;
    if (secret) {
      const sig = req.headers['elevenlabs-signature'];
      if (!verifyElevenLabsSignature(body, sig, secret)) {
        console.error('[webhook] Invalid or missing signature, rejecting');
        res.writeHead(401); res.end('Unauthorized'); return;
      }
    }
    try {
      const payload = JSON.parse(body);
      const dv = (payload && payload.data && payload.data.conversation_initiation_client_data && payload.data.conversation_initiation_client_data.dynamic_variables) || {};
      const callGuid = dv.sip_call_guid;
console.log('[webhook] received for call_guid:', callGuid || 'unknown');
      if (callGuid && pendingWebhooks.has(callGuid)) {
        const waiter = pendingWebhooks.get(callGuid);
        pendingWebhooks.delete(callGuid);
        clearTimeout(waiter.timeoutId);
        waiter.resolve(payload);
        console.log('[webhook] matched and resolved');
      } else {
        console.log('[webhook] no matching pending call');
      }
      res.writeHead(200); res.end('OK');
    } catch (e) {
      console.error('[webhook] parse error:', e.message);
      res.writeHead(400); res.end('Bad payload');
    }
  });
});

webhookServer.listen(config.webhook.port, () => {
  console.log('Webhook server listening on port ' + config.webhook.port);
});

async function handleElevenLabs(conn, uuid, ctx) {
  const { log, logErr, callGuid, customerId } = ctx;
  if (!callGuid) {
    logErr('No X-Call-GUID, cannot correlate webhook');
    return { result: '0', extraHeaders: { 'X-Error': 'no_call_guid' } };
  }

  const webhookPromise = new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingWebhooks.delete(callGuid);
      log('Webhook timeout after 5 min');
      resolve(null);
    }, 300000);
    pendingWebhooks.set(callGuid, { resolve, timeoutId });
  });

  await sendInboundCommand('uuid_setvar ' + uuid + ' hangup_after_bridge false').catch(() => {});

  const el = config.elevenlabs;
  const bridgeVars = [
    'sip_auth_username=' + el.sipUser,
    'sip_auth_password=' + el.sipPassword,
    'sip_h_X-Call-GUID=' + callGuid,
    'sip_h_X-Customer-ID=' + customerId,
  ].join(',');
  const bridgeStr = '[' + bridgeVars + ']sofia/external/' + el.sipNumber + '@' + el.sipHost + ';transport=' + el.transport;
  log('Bridging to ElevenLabs');

  try {
    await conn.execute('bridge', bridgeStr);
    log('Bridge call completed');
  } catch (e) {
    const msg = (e && e.message) || String(e);
    // ESL library has a 10s command-reply timeout. Long calls trigger this
    // but the bridge itself continues in FreeSWITCH; webhook arrival is the
    // real end-of-call signal.
    if (msg.indexOf('FreeSwitchTimeout') >= 0 || msg.indexOf('Timeout after') >= 0) {
      log('Bridge call in progress (ESL command timeout is expected for long calls)');
    } else {
      logErr('Bridge error:', msg);
    }
  }
  log('Waiting for ElevenLabs webhook...');

  const webhookData = await webhookPromise;
  if (!webhookData) {
    return { result: '0', extraHeaders: { 'X-Error': 'webhook_timeout' } };
  }

  const data = webhookData.data || {};
  const dc = (data.analysis && data.analysis.data_collection_results) || {};
  const account = (dc.account && dc.account.value) || '';
  const conversationId = data.conversation_id || '';
  const terminationReason = (data.metadata && data.metadata.termination_reason) || '';
  log('Account:', account, '| Termination:', terminationReason);

  return {
    result: account ? '1' : '0',
    extraHeaders: {
      'X-Account': account,
      'X-EL-Conversation-ID': conversationId,
      'X-Termination-Reason': terminationReason,
    }
  };
}
// =====================================================
