import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

const MODULE_NAME = 'lore_graph';
const EXTENSION_FOLDER = 'third-party/lore-graph';

// Configuration only. The graph and chunk index are stored as JSON files, never here.
const defaultSettings = {
    enabled: false,
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Fill in any keys added by newer versions without touching existing values.
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = structuredClone(value);
        }
    }
    return extension_settings[MODULE_NAME];
}

export async function init() {
    const settings = getSettings();

    const html = await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    $('#extensions_settings2').append(html);

    $('#lore_graph_enabled').prop('checked', settings.enabled).on('input', function () {
        settings.enabled = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    console.log('Lore Graph: loaded');
}
