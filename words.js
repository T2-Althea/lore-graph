// Loads the ordinary English word list (lib/common-words.txt, 12dicts "2of12inf", see
// lib/common-words-NOTICE.txt) and switches the ordinary-word rule on or off.

import { setOrdinaryWords } from './retrieval.js';

/** @type {Promise<string[]>|null} */
let loading = null;

function loadWordList() {
    loading ??= fetch(new URL('./lib/common-words.txt', import.meta.url))
        .then(response => {
            if (!response.ok) throw new Error(`Could not load the word list (${response.status}).`);
            return response.text();
        })
        .then(text => text.split(/\r?\n/).filter(Boolean))
        .catch(error => {
            loading = null;
            throw error;
        });
    return loading;
}

/**
 * @param {boolean} enabled
 * @returns {Promise<boolean>} whether the rule is on afterwards
 */
export async function applyOrdinaryWordRule(enabled) {
    if (!enabled) {
        setOrdinaryWords(null);
        return false;
    }
    try {
        setOrdinaryWords(await loadWordList());
        return true;
    } catch (error) {
        console.error('Lore Graph: ordinary-word rule unavailable', error);
        toastr.warning(String(error?.message ?? error), 'Lore Graph: ordinary-word rule is off');
        setOrdinaryWords(null);
        return false;
    }
}
