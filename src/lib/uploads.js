// Attachment limits, naming and the upload request (POST /api/uploads with the raw
// file as the body; XHR so the composer can show upload progress).

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 10;

export function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function isImage(file) {
  return /^image\//.test(file?.type || '');
}

// Splits `files` into the ones that fit (≤ 50 MB each, ≤ 10 in total with the
// `existing` count) and friendly messages for the rest.
export function checkFiles(files, existing = 0) {
  const accepted = [];
  const problems = [];
  const tooBig = [];
  let skipped = 0;
  for (const file of files) {
    if (!file) continue;
    if (file.size > MAX_FILE_BYTES) tooBig.push(file.name || 'file');
    else if (existing + accepted.length >= MAX_FILES) skipped += 1;
    else accepted.push(file);
  }
  if (tooBig.length === 1) problems.push(`${tooBig[0]} is over the 50 MB limit.`);
  else if (tooBig.length > 1) problems.push(`${tooBig.length} files are over the 50 MB limit.`);
  if (skipped) problems.push(`You can attach up to ${MAX_FILES} files per message; ${skipped} ${skipped === 1 ? 'was' : 'were'} left out.`);
  return { accepted, problems };
}

const pad = (n) => String(n).padStart(2, '0');

// Clipboard images arrive as "image.png"; give them a readable, unique-ish name.
export function uploadName(file, { pasted = false, now = new Date() } = {}) {
  const name = file?.name || '';
  if (pasted && (!name || /^image\.\w+$/i.test(name))) {
    const ext = (file?.type || 'image/png').split('/')[1]?.replace('jpeg', 'jpg').replace(/\W.*$/, '') || 'png';
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
    return `Pasted image ${stamp}.${ext}`;
  }
  return name || 'file';
}

export function uploadUrl(scope, name) {
  return `/api/uploads?scope=${encodeURIComponent(scope || 'draft')}&name=${encodeURIComponent(name)}`;
}

// Uploads one file. Returns { promise, abort }; the promise resolves to the server's
// Attachment and rejects with an Error carrying a user-facing message.
export function uploadFile(file, { scope, name = file.name, onProgress = () => {}, XHR = globalThis.XMLHttpRequest } = {}) {
  const xhr = new XHR();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', uploadUrl(scope, name));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText || 'null');
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve(data);
      else if (xhr.status === 413) reject(new Error('Too large to upload (50 MB max).'));
      else reject(new Error(data?.error || `Upload failed (${xhr.status || 'network'}).`));
    };
    xhr.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { aborted: true }));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
