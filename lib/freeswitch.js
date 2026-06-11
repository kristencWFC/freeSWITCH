const net = require('net');

const ESL_INBOUND_PORT = 8021;
const ESL_PASSWORD = 'ClueCon';

// Send an api command via a fresh inbound ESL connection.
// Returns the result string (e.g. '+OK' or '-ERR ...') or 'timeout'.
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

// Read a SIP header value off a channel. Returns '' if missing/undef.
async function getSipHeader(conn, uuid, headerName) {
  try {
    const r = await conn.api('uuid_getvar ' + uuid + ' sip_h_' + headerName);
    const val = (r && r.body ? r.body : '').toString().trim();
    if (!val || val === '_undef_' || val.startsWith('-ERR')) return '';
    return val;
  } catch(e) {
    return '';
  }
}

module.exports = { sendInboundCommand, getSipHeader };
