// Saves and loads the extension's data as files in the user's data folder
// (data/<user>/user/files/) through SillyTavern's /api/files endpoints.
// Settings (extension_settings) hold configuration only, never this data.

import { getRequestHeaders } from '../../../../script.js';
import { convertTextToBase64 } from '../../../utils.js';
import { deleteFileFromServer } from '../../../chats.js';

export const FILE_PREFIX = 'lore-graph_';
export const CHUNK_INDEX_FILE = `${FILE_PREFIX}chunks.json`;

/**
 * Turns any name into one the upload endpoint accepts (letters, digits, _ - .).
 * @param {string} name
 * @returns {string}
 */
export function toSafeFileName(name) {
    return String(name).replace(/[^a-zA-Z0-9_\-.]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file';
}

/**
 * @param {string} fileName must already be a safe file name
 * @returns {string} URL the file is served from
 */
export function getFileUrl(fileName) {
    return `/user/files/${fileName}`;
}

/**
 * Uploads text as a file. Returns the file's URL.
 * @param {string} fileName
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function saveTextFile(fileName, text) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: fileName, data: convertTextToBase64(text) }),
    });
    if (!response.ok) {
        throw new Error(`Could not save ${fileName}: ${response.status} ${await response.text()}`);
    }
    const result = await response.json();
    return result.path ? `/${String(result.path).replace(/^\/+/, '')}` : getFileUrl(fileName);
}

/**
 * Reads a file as text, bypassing the browser cache. Returns null if it doesn't exist.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export async function loadTextFile(url) {
    const response = await fetch(url, { method: 'GET', cache: 'no-store', headers: getRequestHeaders() });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Could not read ${url}: ${response.status}`);
    }
    return await response.text();
}

/**
 * @param {string} fileName
 * @param {any} data
 */
export async function saveJsonFile(fileName, data) {
    await saveTextFile(fileName, JSON.stringify(data));
}

/**
 * @param {string} fileName
 * @returns {Promise<any|null>} parsed JSON, or null if the file doesn't exist
 */
export async function loadJsonFile(fileName) {
    // A read that lands while the same file is being saved can see it half-written; try again shortly.
    for (const wait of [300, 1000, 0]) {
        const text = await loadTextFile(getFileUrl(fileName));
        if (text === null) {
            return null;
        }
        try {
            return JSON.parse(text);
        } catch (error) {
            if (!wait) throw error;
            await new Promise(resolve => setTimeout(resolve, wait));
        }
    }
}

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function deleteFile(url) {
    return await deleteFileFromServer(url, true);
}
