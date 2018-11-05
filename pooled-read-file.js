require('.');
const fs = require('fs');
// Monkeypatch readFile to continuify.
fs.readFile = (() => {
  const rfInternal = fs.readFile;
  return (...args) => {
    let cb = args[args.length - 1];
    // Continuify cb.
    cb = continuify(cb, 'readFile');
    args[args.length - 1] = cb;
    return rfInternal(...args);
  };
})();

/**
 * Like fs.readFile, but only allows MAX_CONCURRENT_READS simultaneous open
 * files at a time.
 */
const pooledReadFile = (() => {
  const MAX_CONCURRENT_READS = 2;
  let numConcurrentReads = 0;
  let readFileRequests = [];

  return (...readFileArgs) => {
    // Retrieve the callback, assuming that the callback comes last.
    let cb = readFileArgs[readFileArgs.length - 1];
    // Continuify cb.
    cb = continuify(cb, 'pooledReadFile');
    // Wrap cb to also drain queued requests.
    readFileArgs[readFileArgs.length - 1] = function readFileCb(...cbArgs) {
      numConcurrentReads--;
      cb(...cbArgs);
      // Retrieve the first outstanding read file request and execute it.
      if (readFileRequests.length > 0) {
        const request = readFileRequests.shift();
        numConcurrentReads++;
        fs.readFile(...request);
      }
    };
    if (numConcurrentReads < MAX_CONCURRENT_READS) {
      // We do not have MAX_CONCURRENT_READS number of files open at a time,
      // so immediately call fs.readFile.
      numConcurrentReads++;
      fs.readFile(...readFileArgs);
    } else {
      // We have hit the limit for number of files open at a time, so enqueue
      // the request for later.
      readFileRequests.push(readFileArgs);
    }
  }
})();

const p = __filename;
require('http').createServer(function reqHandler(req, res) {
  if (req.query.id === 1) { pooledReadFile(p, function f1() { res.end(); }); }
  if (req.query.id === 2) { pooledReadFile(p, function f2() { res.end(); }); }
  if (req.query.id === 3) { pooledReadFile(p, function f3() { res.end(); }); }
}).listen(80);
