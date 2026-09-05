// lib/drive.js — read a Colab notebook out of Google Drive.
// Colab stores every /drive/<id> notebook as a regular Drive file with
// mimeType application/vnd.google.colaboratory (plain .ipynb JSON bytes), so
// `files.get?alt=media` returns exactly what "File → Download .ipynb" would.

import { googleToken, forgetGoogleToken } from './auth.js';

const DRIVE = 'https://www.googleapis.com/drive/v3/files';

async function driveFetch(url, { interactive = false } = {}, attempt = 0) {
  const token = await googleToken({ interactive });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && attempt === 0) {
    await forgetGoogleToken();
    return driveFetch(url, { interactive }, 1);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message || res.statusText || 'Drive request failed';
    const e = new Error(`Google Drive: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return res;
}

/** @returns {{id,name,mimeType,modifiedTime,md5Checksum,size,webViewLink}} */
export async function getFileMeta(fileId, opts) {
  const fields = 'id,name,mimeType,modifiedTime,md5Checksum,size,webViewLink,owners(emailAddress)';
  const res = await driveFetch(`${DRIVE}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`, opts);
  return res.json();
}

/** @returns {Promise<string>} raw notebook JSON text */
export async function downloadNotebook(fileId, opts) {
  const res = await driveFetch(`${DRIVE}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, opts);
  return res.text();
}
