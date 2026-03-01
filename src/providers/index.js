import openaiProvider from './openai.js';
import anthropicProvider from './anthropic.js';
import googleProvider from './google.js';
import elevenlabsProvider from './elevenlabs.js';
import openaiCompatibleProvider from './openai-compatible.js';

const providers = {
    openai: openaiProvider,
    anthropic: anthropicProvider,
    google: googleProvider,
    elevenlabs: elevenlabsProvider,
    'openai-compatible': openaiCompatibleProvider,
};

export function getProvider(name) {
    const provider = providers[name];
    if (!provider) {
        const available = Object.keys(providers).join(', ');
        throw new Error(`Unknown provider "${name}". Available: ${available}`);
    }
    return provider;
}

export function listProviders() {
    return Object.keys(providers);
}

export { providers };
