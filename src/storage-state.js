import { stat } from 'node:fs/promises';
import { request } from 'playwright-core';

export async function requestContextFromStorageState(storageStatePath) {
  const metadata = await stat(storageStatePath);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Storage state must not be accessible by group or other users');
  }
  return request.newContext({ storageState: storageStatePath });
}

