import { stat } from 'node:fs/promises';

export async function requestContextFromStorageState(storageStatePath) {
  const metadata = await stat(storageStatePath);
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Storage state must not be accessible by group or other users');
  }
  const { request } = await import('playwright-core');
  return request.newContext({ storageState: storageStatePath });
}
