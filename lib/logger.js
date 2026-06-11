// GUID-prefixed logger so all log lines for a single call can be grep'd
function makeLogger(guid) {
  const prefix = guid ? '[' + guid + ']' : '[no-guid]';
  return {
    log: (...args) => console.log(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
    info: (...args) => console.log(prefix, ...args),
    debug: (...args) => console.log(prefix, ...args),
  };
}

module.exports = { makeLogger };
