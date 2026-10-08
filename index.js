const HUD_POSITION_KEY = 'story-director-hud-position';

const storyDirectorState = {
    suggestions: [],
    activeSuggestion: null,
    activeInstruction: null,
    eventGenerationInProgress: false,
    applyingSuggestion: false,
};

const STORY_DIRECTOR_EMPTY_HTML = `<div class="story-director-empty">No suggestions yet.<br><span>The wise owl is ready when you are. 🦉</span></div>`;
function resetStoryDirectorRound() {
    storyDirectorState.suggestions = [];
    storyDirectorState.activeSuggestion = null;
    storyDirectorState.activeInstruction = null;
    const result = document.getElementById('story-director-result');
    if (result) result.innerHTML = STORY_DIRECTOR_EMPTY_HTML;
    const direction = document.getElementById('story-director-direction');
    if (direction) direction.value = '';
}
function normalizeStoryDirectorTask(task) { return task === 'storythread' ? 'story-thread' : task; }
function getStoryDirectorDirectionInstruction(direction) {
    if (!direction?.trim()) return '';
    return `
=== OPTIONAL CREATIVE DIRECTION ===
${direction.trim()}
=== END OF DIRECTION ===
Treat this idea as creative direction, NOT an event that has already happened and NOT a fully written scene. Develop one plausible implementation that fits the story context and the selected slot's tone. Every slot is an alternative: vary the mechanism, revelation, or consequence instead of restating the same idea.
`;
}

function getStoryDirectorOption(key, elementId) {
    return document.getElementById(elementId)?.checked ?? loadSuggestionSettings()?.[key] ?? true;
}

function getStoryDirectorGenerationTokens(kind) {
    const defaults = { event: 800, twist: 1400, timeskip: 1200, unstuck: 1600 };
    const positiveTokens = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
    if (getStoryDirectorOption('customTokens', 'story-director-custom-tokens')) {
        return positiveTokens(document.getElementById(`story-director-tokens-${kind}`)?.value)
            ?? positiveTokens(loadSuggestionSettings()?.tokens?.[kind]) ?? defaults[kind];
    }
    const context = SillyTavern.getContext();
    const service = context.ConnectionManagerRequestService;
    const profileId = context.extensionSettings?.connectionManager?.selectedProfile;
    let api = context.mainApi, preset;
    try {
        const profile = service?.getProfile?.(profileId);
        api = service?.validateProfile?.(profile)?.selected ?? api;
        const manager = context.getPresetManager?.(api);
        preset = profile?.preset ? manager?.getCompletionPresetByName?.(profile.preset) : null;
    } catch { /* Older hosts may not expose profile/preset readers. */ }
    const value = api === 'textgenerationwebui'
        ? positiveTokens(preset?.genamt) ?? positiveTokens(context.textCompletionSettings?.genamt)
        : positiveTokens(preset?.openai_max_tokens) ?? positiveTokens(context.chatCompletionSettings?.openai_max_tokens);
    // sendRequest requires a response budget. Keep the existing generic 800-token
    // safety fallback only when the host exposes no usable generation setting.
    return value ?? 800;
}

async function generateDirectorResponse(prompt, maxTokens, retryOnEmpty = true) {
    const context = SillyTavern.getContext();
    const connectionService =
        context.ConnectionManagerRequestService;

    const profileId =
        context.extensionSettings?.connectionManager?.selectedProfile;

    if (!profileId) {
        throw new Error(
            '[Story Director] No active connection profile found.'
        );
    }

    const extractResponseText = (result) => {
        if (typeof result === 'string' && result.trim()) {
            return result.trim();
        }

        const candidates = [
            result?.content,
            result?.text,
            result?.response?.content,
            result?.response?.text,
            result?.message?.content,
            result?.choices?.[0]?.message?.content,
            result?.choices?.[0]?.text,
            result?.data?.content,
            result?.data?.text,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }

        return null;
    };

    const request = async (requestPrompt, requestTokens) => {
        const result = await connectionService.sendRequest(
            profileId,
            requestPrompt,
            requestTokens,
            {
                stream: false,
                extractData: true,
            },
            {
                reasoning_effort: 'low',
            }
        );

        console.log(
            '[Story Director] RAW API RESULT:',
            result
        );

        console.log(
            '[Story Director] CONTENT CHECK:',
            typeof result?.content,
            Boolean(result?.content),
            result?.content
        );

        const text = extractResponseText(result);

        if (text) {
            return text;
        }

        return {
            empty: true,
            hasReasoning: Boolean(result?.reasoning),
            raw: result,
        };
    };

    try {
        const firstAttempt = await request(prompt, maxTokens);

        if (typeof firstAttempt === 'string') {
            return firstAttempt;
        }

        // Some models occasionally return only reasoning instead of a final response;
        // one concise retry prevents the generation process from failing.
        //
        if (retryOnEmpty && firstAttempt?.empty) {
            console.warn(
                '[Story Director] Empty response received; trying a shorter retry.'
            );

            const retryPrompt = `${prompt}\n\n=== IMPORTANT OUTPUT INSTRUCTION ===\nOutput only the finished answer now. No analysis, reasoning, planning, or meta explanation. Start directly with the requested title or result, in English.`;

            const retryTokens = Math.min(Number(maxTokens) || 800, 1000);
            const secondAttempt = await request(retryPrompt, retryTokens);

            if (typeof secondAttempt === 'string') {
                return secondAttempt;
            }
        }

        throw new Error(
            '[Story Director] The AI returned no text.'
        );
    } catch (error) {
        console.error(
            '[Story Director] Generation failed:',
            error
        );

        throw error;
    }
}

window.testStoryDirectorConnection = async () => {
    try {
        const response = await generateDirectorResponse(
            'Antworte nur mit: Story Director online.',
            100
        );

        console.log(
            '[Story Director] TEST RESPONSE:',
            response
        );

        return response;
    } catch (error) {
        console.error(
            '[Story Director] TEST FAILED:',
            error
        );

        throw error;
    }
};

function getStoryDirectorChatContext(limit = 30) {
    const context = SillyTavern.getContext();

    const chat = context.chat ?? [];

    const messages = chat
        .filter(message =>
            message &&
            !message.is_system &&
            typeof message.mes === 'string' &&
            message.mes.trim()
        )
        .slice(-limit);

    return messages.map(message => ({
        name: message.name || 'Unbekannt',
        isUser: Boolean(message.is_user),
        text: message.mes.trim(),
    }));
}

async function getStoryDirectorBoundLorebookContext() {
    const context = SillyTavern.getContext();

    const lorebookName =
        context.chatMetadata?.world_info ?? null;

    if (!lorebookName) {
        return {
            lorebookName: null,
            entries: [],
        };
    }

    const worldInfo =
        await context.loadWorldInfo(lorebookName);

    const entries = Object.values(
        worldInfo?.entries ?? {}
    )
        .filter(entry =>
            entry &&
            typeof entry.content === 'string' &&
            entry.content.trim()
        )
        .map(entry => ({
            comment:
                typeof entry.comment === 'string'
                    ? entry.comment.trim()
                    : '',

            content:
                entry.content.trim(),

            key:
                Array.isArray(entry.key)
                    ? entry.key
                    : [],

            secondary:
                Array.isArray(entry.secondary)
                    ? entry.secondary
                    : [],

            constant:
                Boolean(entry.constant),

            order:
                entry.order ?? 0,
        }));

    return {
        lorebookName,
        entries,
    };
}

function findRelevantStoryDirectorLorebookEntries(
    lorebookContext,
    searchText,
    limit = 20
) {
    const entries = lorebookContext?.entries ?? [];

    if (!searchText || !entries.length) {
        return [];
    }

    const stopWords = new Set([
        'und', 'oder', 'der', 'die', 'das',
        'den', 'dem', 'des', 'ein', 'eine',
        'einer', 'einem', 'einen',
        'ist', 'war', 'wird', 'hat', 'haben',
        'sich', 'sie', 'er', 'es', 'ich',
        'du', 'wir', 'ihr', 'mit', 'von',
        'auf', 'für', 'aus', 'bei', 'nach',
        'vor', 'über', 'unter', 'aber',
        'nicht', 'noch', 'nur', 'auch',
        'dann', 'wenn', 'wie', 'so',
        'the', 'and', 'or', 'was', 'were',
        'this', 'that', 'with', 'from',
    ]);

    const words = searchText
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(word => word.trim())
        .filter(word =>
            word.length >= 3 &&
            !stopWords.has(word)
        );

    const uniqueWords = [...new Set(words)];

    const scoredEntries = entries.map(entry => {
        const keys = [
            ...(entry.key ?? []),
            ...(entry.secondary ?? []),
        ]
            .filter(value => typeof value === 'string')
            .map(value => value.trim().toLowerCase());

        const comment =
            (entry.comment ?? '').toLowerCase();

        let score = 0;

        for (const word of uniqueWords) {

            // Exakte bzw. sehr direkte Treffer in Lorebook-Keys
            for (const key of keys) {
                if (
                    key === word ||
                    key.includes(word)
                ) {
                    score += 20;
                }
            }

            // Treffer im Namen / Kommentar des Eintrags
            if (comment.includes(word)) {
                score += 8;
            }
        }

        // Constant entries are generally somewhat more important.
        if (entry.constant) {
            score += 3;
        }

        return {
            ...entry,
            score,
        };
    });

    return scoredEntries
        .filter(entry => entry.score >= 8)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

async function getStoryDirectorRelevantLorebookContext(
    chatLimit = 10,
    loreLimit = 20
) {
    const storyContext =
        getStoryDirectorChatContext(chatLimit);

    const lorebook =
        await getStoryDirectorBoundLorebookContext();

    const searchText = storyContext
        .map(message => message.text)
        .join('\n');

    const relevantEntries =
        findRelevantStoryDirectorLorebookEntries(
            lorebook,
            searchText,
            loreLimit
        );

    return {
        lorebookName: lorebook.lorebookName,
        searchText,
        entries: relevantEntries,
    };
}

window.testStoryDirectorRelevantLorebook = async () => {
    return await getStoryDirectorRelevantLorebookContext(
        100,
        20
    );
};

window.testStoryDirectorLorebookSearch = async () => {
    const lorebook =
        await getStoryDirectorBoundLorebookContext();

    return findRelevantStoryDirectorLorebookEntries(
        lorebook,
        'Naruto Mitsuki Konoha Training',
        20
    );
};

window.testStoryDirectorBoundLorebook = async () => {
    return await getStoryDirectorBoundLorebookContext();
};

window.testStoryDirectorChatContext = () => {
    return getStoryDirectorChatContext(30);
};

function getStoryDirectorWorldInfoContext(chatLimit = 100) {
    const context = SillyTavern.getContext();

    const chat = context.chat ?? [];

    const chatForWorldInfo = chat
        .filter(message =>
            message &&
            !message.is_system &&
            typeof message.mes === 'string' &&
            message.mes.trim()
        )
        .slice(-chatLimit)
        .map(message =>
            `${message.name || ''}: ${message.mes.trim()}`
        )
        .reverse();

    return context.getWorldInfoPrompt(
        chatForWorldInfo,
        25700,
        true
    );
}

window.testStoryDirectorWorldInfoContext = async () => {
    return await getStoryDirectorWorldInfoContext(100);
};

function getStoryDirectorDoomTrackerContext() {
    const context = SillyTavern.getContext();
    const chat = context.chat ?? [];

    // Die letzte Assistant-Nachricht finden
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];

        if (
            !message ||
            message.is_user ||
            message.is_system
        ) {
            continue;
        }

        const swipeId = message.swipe_id || 0;

        const swipeData =
            message.extra?.dooms_tracker_swipes?.[swipeId];

        if (!swipeData) {
            return null;
        }

        return {
            swipeId,

            quests:
                swipeData.quests ?? null,

            infoBox:
                swipeData.infoBox ?? null,

            characterThoughts:
                swipeData.characterThoughts ?? null,
        };
    }

    return null;
}

async function getStoryDirectorContext({
    chatLimit = 100,
    loreLimit = 20,
} = {}) {
    const chat =
        getStoryDirectorChatContext(chatLimit);

    const relevantLore =
        await getStoryDirectorRelevantLorebookContext(
            chatLimit,
            loreLimit
        );

    const doomTracker =
        getStoryDirectorDoomTrackerContext();

    return {
        chat,
        lore: relevantLore.entries.map(entry =>
            entry.content
        ),
        lorebookName:
            relevantLore.lorebookName,
        doomTracker,
    };
}

window.testStoryDirectorContext = async () => {
    return await getStoryDirectorContext({
        chatLimit: 100,
    });
};

export async function init() {
    console.log('[Story Director] Extension loaded!');
    console.log('[Story Director] Starting UI...');

    if (document.body) {
        createStoryDirectorPanel();
    } else {
        console.log('[Story Director] Body not ready, waiting...');

        document.addEventListener('DOMContentLoaded', () => {
            createStoryDirectorPanel();
        }, { once: true });
    }
}


const STORY_DIRECTOR_INJECTION_ID = 'story-director-active-suggestion';

async function clearStoryDirectorInjection() {
    const context = SillyTavern.getContext();

    if (typeof context.setExtensionPrompt === 'function') {
        try {
            await context.setExtensionPrompt(
                STORY_DIRECTOR_INJECTION_ID,
                '',
                0,
                0,
                false,
                1
            );
        } catch (error) {
            console.warn(
                '[Story Director] Could not clear active suggestion injection:',
                error
            );
        }
    }

    storyDirectorState.activeSuggestion = null;
    storyDirectorState.activeInstruction = null;
}

async function applyStoryDirectorSuggestion(response) {
    if (storyDirectorState.applyingSuggestion || storyDirectorState.eventGenerationInProgress) {
        throw new Error('[Story Director] Another generation or application is already running.');
    }
    storyDirectorState.applyingSuggestion = true;
    try {
        await performStoryDirectorSuggestion(response);
        resetStoryDirectorRound();
    } finally {
        storyDirectorState.applyingSuggestion = false;
    }
}

async function performStoryDirectorSuggestion(response) {
    const suggestion = String(response ?? '').trim();

    if (!suggestion) {
        throw new Error('[Story Director] The suggestion is empty.');
    }

    const context = SillyTavern.getContext();

    if (typeof context.setExtensionPrompt !== 'function') {
        throw new Error(
            '[Story Director] SillyTavern does not provide setExtensionPrompt.'
        );
    }

    const injection = `
<OOC>
MANDATORY DIRECTION FOR THE VERY NEXT ROLEPLAY REPLY

The following direction MUST be implemented and visibly played out in the immediately following roleplay reply.

Do NOT merely consider this direction internally, think about it, or save it for a later turn.
The described event or time skip must happen NOW in the next reply.

- This is not player dialogue.
- Never mention this OOC instruction, Story Director, or these directions in the roleplay reply.
- Let NPCs act independently and consistently with their characterization.
- Do not invent actions, thoughts, or decisions for the player's character.
- Implement the direction as part of the normal roleplay narration.
- Do not postpone its implementation to a future reply.
- A vague hint or suggestion that the event might happen is NOT sufficient.
- Write the roleplay reply in English.

=== MANDATORY STORY DIRECTION ===
${suggestion}
=== END OF DIRECTION ===
</OOC>`;

    await context.setExtensionPrompt(
        STORY_DIRECTOR_INJECTION_ID,
        injection,
        0,
        0,
        false,
        1
    );

    storyDirectorState.activeSuggestion = suggestion;
    storyDirectorState.activeInstruction = injection;

    console.log(
        '[Story Director] Suggestion applied to the next AI reply.'
    );

    if (typeof context.generate !== 'function') {
        await clearStoryDirectorInjection();
        throw new Error(
            '[Story Director] SillyTavern context.generate was not found.'
        );
    }

    try {
        // The direction has already been added through setExtensionPrompt().
        // Trigger the normal SillyTavern roleplay generation
        // without any additional user prompt.
        const generated = await context.generate();
        if (generated === false) throw new Error('[Story Director] Roleplay generation was cancelled.');
    } finally {
        // The Director direction applies to this reply only.
        await clearStoryDirectorInjection();
    }
}

function createStoryDirectorActionButton(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `story-director-card-button ${className}`;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
}

function createStoryDirectorResultCard({
    label,
    response,
    failed = false,
    icon = '🎲',
    acceptInstruction = null,
}) {
    const card = document.createElement('div');
    card.className = 'story-director-result-card';

    const title = document.createElement('strong');
    title.textContent = `${failed ? '⚠️' : icon} ${label}`;
    card.appendChild(title);

    const text = document.createElement('div');
    text.className = 'story-director-result-text';
    text.textContent = response ?? '';
    card.appendChild(text);

    if (failed) {
        return card;
    }

    const editor = document.createElement('textarea');
    editor.className = 'story-director-result-editor';
    editor.value = response ?? '';
    editor.style.display = 'none';
    editor.setAttribute('aria-label', 'Edit Story Director suggestion');

    const actions = document.createElement('div');
    actions.className = 'story-director-card-actions';

    const editButton = createStoryDirectorActionButton(
        '✏️ Edit',
        'story-director-edit-button',
        () => {
            const editing = editor.style.display !== 'none';

            if (editing) {
                text.textContent = editor.value.trim();
                editor.style.display = 'none';
                editButton.textContent = '✏️ Edit';
            } else {
                editor.value = text.textContent;
                editor.style.display = 'block';
                editButton.textContent = '💾 Save';
                editor.focus();
            }
        }
    );

    const acceptButton = createStoryDirectorActionButton(
        '✅ Apply',
        'story-director-accept-button',
        async () => {
            const currentText =
                editor.style.display !== 'none'
                    ? editor.value.trim()
                    : text.textContent.trim();

            if (!currentText) {
                return;
            }

            text.textContent = currentText;
            editor.value = currentText;
            editor.style.display = 'none';
            editButton.textContent = '✏️ Edit';

            actions.querySelectorAll('button').forEach(button => {
                button.disabled = true;
            });

            const originalLabel = acceptButton.textContent;
            acceptButton.textContent = '🦉 Applying...';

            try {
                const instructionToApply = acceptInstruction
                    ? acceptInstruction + '\n\n=== CURRENT/EDITED TEXT ===\n' + currentText
                    : currentText;

                await applyStoryDirectorSuggestion(instructionToApply);
            } catch (error) {
                console.error(
                    '[Story Director] Suggestion apply failed:',
                    error
                );
                acceptButton.disabled = false;
                editButton.disabled = false;
                acceptButton.textContent = originalLabel;
                throw error;
            }
        }
    );

    actions.appendChild(editButton);
    actions.appendChild(acceptButton);

    card.appendChild(editor);
    card.appendChild(actions);

    return card;
}

function formatStoryDirectorContextForPrompt(storyContext) {
    const chatText = (storyContext.chat ?? [])
        .map(message => {
            const speaker = message.isUser
                ? 'USER'
                : (message.name || 'CHARACTER');

            return `${speaker}: ${message.text}`;
        })
        .join('\n\n');

    const loreText = (storyContext.lore ?? [])
        .map((entry, index) =>
            `[Lorebook ${index + 1}]\n${entry}`
        )
        .join('\n\n');

    const doom = storyContext.doomTracker;

    let doomText = '';

    if (doom) {
        doomText = [
            '[DOOM TRACKER]',

            doom.infoBox
                ? `Scene / InfoBox:\n${doom.infoBox}`
                : '',

            doom.quests
                ? `Quests:\n${doom.quests}`
                : '',

            doom.characterThoughts
                ? `Character Thoughts:\n${doom.characterThoughts}`
                : '',
        ]
            .filter(Boolean)
            .join('\n\n');
    }

   

    return [
        '=== CHAT HISTORY ===',
        chatText || '(No chat history available.)',

        '=== LOREBOOK / WORLD INFO ===',
        loreText || '(No relevant lorebook entries are active.)',

        '=== DOOM TRACKER ===',
        doomText || '(No Doom Tracker data available.)',
    ].join('\n\n');
}

window.testStoryDirectorFormattedContext = async () => {
    const storyContext = await getStoryDirectorContext({
        chatLimit: 100,
    });

    return formatStoryDirectorContextForPrompt(storyContext);
};

function createStoryDirectorPanel() {
    if (document.getElementById('story-director-panel')) {
        return;
    }

    const toggle = document.createElement('button');
    toggle.id = 'story-director-toggle';
    toggle.className = 'story-director-toggle';
    toggle.type = 'button';
    toggle.textContent = '🦉';
    toggle.title = 'Open Story Director';

    const panel = document.createElement('div');
    panel.id = 'story-director-panel';
    panel.className = 'story-director-panel story-director-collapsed';

    panel.innerHTML = `
        <div class="story-director-header">
            <div>
                <div class="story-director-title">
                    🦉 Story Director
                </div>

                <div class="story-director-subtitle">
                    Your story's little director
                </div>
            </div>

            <button
                class="story-director-close"
                type="button"
                title="Close Story Director"
            >
                ×
            </button>
        </div>

        <div class="story-director-section">
            <div class="story-director-section-title">
                🎬 Direct the Story
            </div>

            <label for="story-director-direction">Idea / direction for an event or twist (optional)</label>
            <textarea id="story-director-direction" class="story-director-direction" rows="2" placeholder="Generate freely, or enter a creative direction…"></textarea>

            <button class="story-director-button" data-action="event">
                🎲 Generate Event
            </button>

            <button class="story-director-button" data-action="twist">
                🌀 Generate Twist
            </button>

            <button class="story-director-button" data-action="timeskip">
                ⏩ Time Skip
            </button>

            <button class="story-director-button" data-action="unstuck">
                🆘 Story Stuck?
            </button>
                        
            <button class="story-director-button" data-action="settings">
                ⚙️ Settings
            </button>
        </div>

        <div class="story-director-result" id="story-director-result">
            ${STORY_DIRECTOR_EMPTY_HTML}
        </div>
                <div class="story-director-settings" id="story-director-settings">
            <div class="story-director-settings-header">
                <strong>⚙️ Suggestion Settings</strong>

                <button
                    class="story-director-back"
                    type="button"
                    title="Back"
                >
                    ←
                </button>
            </div>

         <div class="story-director-settings-content">

    <label
        class="story-director-setting-label"
        for="story-director-slot-count"
    >
        Number of suggestions
    </label>

    <select
        id="story-director-slot-count"
        class="story-director-select"
    >
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3" selected>3</option>
        <option value="4">4</option>
    </select>

    <div
        id="story-director-slots"
        class="story-director-slots"
    ></div>
        <div class="story-director-options">

        <label class="story-director-checkbox">
            <input
                type="checkbox"
                id="story-director-different"
                checked
            >
            <span>Suggestions must be different</span>
        </label>

        <label class="story-director-checkbox">
            <input
                type="checkbox"
                id="story-director-story-threads"
                checked
            >
            <span>Prefer existing plot threads</span>
        </label>

        <label class="story-director-checkbox">
            <input
                type="checkbox"
                id="story-director-avoid-recent"
                checked
            >
            <span>Avoid recently used ideas</span>
        </label>

    </div>
   
    <div class="story-director-generation">

        <div class="story-director-generation-title">
            🧠 Director Generation
        </div>

        <label class="story-director-checkbox">
            <input
                type="checkbox"
                id="story-director-custom-tokens"
                checked
            >
            <span>Use separate Director response lengths</span>
        </label>

        <div class="story-director-token-settings">

            <div class="story-director-token-setting">
                <label
                    class="story-director-setting-label"
                    for="story-director-tokens-event"
                >
                    🎲 Event
                </label>

                <select
                    id="story-director-tokens-event"
                    class="story-director-select"
                >
                    <option value="500">500 Tokens</option>
                    <option value="800" selected>800 Tokens</option>
                    <option value="1200">1200 Tokens</option>
                    <option value="1600">1600 Tokens</option>
                    <option value="2000">2000 Tokens</option>
                </select>
            </div>

            <div class="story-director-token-setting">
                <label
                    class="story-director-setting-label"
                    for="story-director-tokens-twist"
                >
                    🌀 Twist
                </label>

                <select
                    id="story-director-tokens-twist"
                    class="story-director-select"
                >
                    <option value="800">800 Tokens</option>
                    <option value="1200">1200 Tokens</option>
                    <option value="1400" selected>1400 Tokens</option>
                    <option value="1600">1600 Tokens</option>
                    <option value="2000">2000 Tokens</option>
                </select>
            </div>

            <div class="story-director-token-setting">
                <label
                    class="story-director-setting-label"
                    for="story-director-tokens-timeskip"
                >
                    ⏩ Time Skip
                </label>

                <select
                    id="story-director-tokens-timeskip"
                    class="story-director-select"
                >
                    <option value="800">800 Tokens</option>
                    <option value="1200" selected>1200 Tokens</option>
                    <option value="1600">1600 Tokens</option>
                    <option value="2000">2000 Tokens</option>
                </select>
            </div>

            <div class="story-director-token-setting">
                <label
                    class="story-director-setting-label"
                    for="story-director-tokens-unstuck"
                >
                    🆘 Unstick Story
                </label>

                <select
                    id="story-director-tokens-unstuck"
                    class="story-director-select"
                >
                    <option value="1000">1000 Tokens</option>
                    <option value="1400">1400 Tokens</option>
                    <option value="1600" selected>1600 Tokens</option>
                    <option value="2000">2000 Tokens</option>
                    <option value="2500">2500 Tokens</option>
                </select>
            </div>

        </div>

    </div>
</div>
    `;

    document.body.appendChild(toggle);
    document.body.appendChild(panel);

    restoreHudPosition(toggle, panel);

    setupToggle(toggle, panel);
    setupCloseButton(toggle, panel);
    setupDragging(toggle, panel);
    setupSettingsBackButton(panel);
    setupSuggestionSettings(panel);

    


    panel.querySelectorAll('.story-director-button').forEach(button => {
        button.addEventListener('click', () => {
            handleDirectorAction(button.dataset.action);
        });
    });

    console.log('[Story Director] UI created!');
}

function setupToggle(toggle, panel) {
    toggle.addEventListener('click', () => {
        if (toggle.dataset.wasDragged === 'true') {
            toggle.dataset.wasDragged = 'false';
            return;
        }

        panel.classList.remove('story-director-collapsed');
        toggle.classList.add('story-director-hidden');
        toggle.title = 'Story Director is open';
    });
}

function setupCloseButton(toggle, panel) {
    const closeButton = panel.querySelector('.story-director-close');

    closeButton.addEventListener('click', () => {
        panel.classList.add('story-director-collapsed');
        toggle.classList.remove('story-director-hidden');
        toggle.title = 'Open Story Director';
    });
}

function setupDragging(toggle, panel) {
    setupDraggable(toggle);
    setupDraggable(panel, panel.querySelector('.story-director-header'));
}

function setupDraggable(element, handle = element) {
    let dragging = false;
    let moved = false;

    let startPointerX = 0;
    let startPointerY = 0;

    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) {
            return;
        }

        dragging = true;
        moved = false;

        startPointerX = event.clientX;
        startPointerY = event.clientY;

        const rect = element.getBoundingClientRect();

        startLeft = rect.left;
        startTop = rect.top;

        element.style.left = `${startLeft}px`;
        element.style.top = `${startTop}px`;
        element.style.right = 'auto';

        if (element === toggle) {
            toggle.dataset.wasDragged = 'false';
        }

        handle.setPointerCapture?.(event.pointerId);
    });

    handle.addEventListener('pointermove', event => {
        if (!dragging) {
            return;
        }

        const deltaX = event.clientX - startPointerX;
        const deltaY = event.clientY - startPointerY;

        if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) {
            moved = true;
        }

        let newLeft = startLeft + deltaX;
        let newTop = startTop + deltaY;

        const rect = element.getBoundingClientRect();

        const maxLeft = window.innerWidth - rect.width;
        const maxTop = window.innerHeight - rect.height;

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        element.style.left = `${newLeft}px`;
        element.style.top = `${newTop}px`;

        if (element === toggle && moved) {
            toggle.dataset.wasDragged = 'true';
        }
    });

    handle.addEventListener('pointerup', event => {
        if (!dragging) {
            return;
        }

        dragging = false;

        handle.releasePointerCapture?.(event.pointerId);

        snapToEdge(element);
        saveHudPosition(element);
    });

    handle.addEventListener('pointercancel', () => {
        dragging = false;
    });
}

function snapToEdge(element) {
    const rect = element.getBoundingClientRect();

    const distanceLeft = rect.left;
    const distanceRight = window.innerWidth - rect.right;

    const margin = window.innerWidth <= 600 ? 8 : 12;

    if (distanceLeft < distanceRight) {
        element.style.left = `${margin}px`;
    } else {
        element.style.left = `${window.innerWidth - rect.width - margin}px`;
    }

    const updatedRect = element.getBoundingClientRect();

    let top = updatedRect.top;

    top = Math.max(
        margin,
        Math.min(top, window.innerHeight - updatedRect.height - margin)
    );

    element.style.top = `${top}px`;
}

function saveHudPosition(element) {
    const rect = element.getBoundingClientRect();

    const position = {
        left: rect.left,
        top: rect.top
    };

    localStorage.setItem(
        HUD_POSITION_KEY,
        JSON.stringify(position)
    );
}

function restoreHudPosition(toggle, panel) {
    const saved = localStorage.getItem(HUD_POSITION_KEY);

    if (!saved) {
        return;
    }

    try {
        const position = JSON.parse(saved);

        if (
            typeof position.left !== 'number' ||
            typeof position.top !== 'number'
        ) {
            return;
        }

        const element = toggle;

        element.style.left = `${position.left}px`;
        element.style.top = `${position.top}px`;
        element.style.right = 'auto';
    } catch (error) {
        console.warn(
            '[Story Director] Could not restore HUD position:',
            error
        );
    }
}

async function generateEventForSlot(
    slot,
    formattedContext = null,
    diversityContext = null,
    kind = 'event',
    direction = ''
) {
    const maxTokens = getStoryDirectorGenerationTokens(kind);

    const taskInstruction =
        (kind === 'twist' ? getStoryDirectorTwistInstruction : getStoryDirectorTaskInstruction)(slot.task);

    if (!formattedContext) {
        const storyContext =
            await getStoryDirectorContext({
                chatLimit: 100,
            });

        formattedContext =
            formatStoryDirectorContextForPrompt(
                storyContext
            );
    }

    const previousSuggestions =
        Array.isArray(diversityContext?.previousSuggestions)
            ? diversityContext.previousSuggestions
            : [];

    const requireDifferentSuggestions =
        Boolean(direction.trim()) || (diversityContext?.differentSuggestions ?? true)
            || getStoryDirectorOption('avoidRecentIdeas', 'story-director-avoid-recent');

    const preferenceInstruction = [
        getStoryDirectorOption('preferStoryThreads', 'story-director-story-threads')
            ? 'Prefer established open plot threads when supported by the context and appropriate to the situation. Do not invent unresolved threads or force an unsuitable continuation.' : '',
        getStoryDirectorOption('avoidRecentIdeas', 'story-director-avoid-recent')
            ? 'Avoid repeating ideas, twists, and events from recent available chat history and this suggestion round. A deliberately selected plot-thread continuation is allowed, but develop a new consequence or turn instead of replaying past events. Do not fabricate an unavailable idea history.' : '',
    ].filter(Boolean).join('\n');
    let diversityInstruction = '';

    if (requireDifferentSuggestions && previousSuggestions.length) {
        const previousText = previousSuggestions
            .map((suggestion, index) =>
                `PREVIOUS SUGGESTION ${index + 1}:\n${suggestion}`
            )
            .join('\n\n');

        diversityInstruction = `
=== ALREADY GENERATED SUGGESTIONS ===
${previousText}

=== IMPORTANT VARIETY RULE ===
This slot must be meaningfully different from the suggestions generated so far.
${direction.trim() ? 'Keep the core of the creative direction; requested characters or locations may recur. However, use a different mechanism, revelation, or consequence that suits this slot\'s tone.' : 'Do not reuse the same character, location, clan, group, object, or story conflict as the main focus unless the selected dramatic focus explicitly calls for continuing that thread.'}
Lorebook entries provide background context, not a requirement to incorporate them into every suggestion.
Choose another relevant angle grounded in the current story context.
`;
    }

    const eventPrompt = `
You are the Story Director of an ongoing long-form roleplay.

Use the story context below to develop ONE concrete idea for a possible upcoming story event.

=== CURRENT STORY CONTEXT ===
${formattedContext}

=== DRAMATIC FOCUS ===
${taskInstruction}
${getStoryDirectorDirectionInstruction(direction)}
${preferenceInstruction}
${diversityInstruction}

=== TASK ===
Create ONE specific story event that could naturally emerge from what has already happened.

IMPORTANT RULES:
- Ground the event in the recent conversation and present situation.
- Consider relevant lorebook information and the Doom Tracker when useful.
- Prefer established character relationships, open situations, and unresolved threads.
- Lorebook entries are background; use them only when genuinely relevant to this suggestion.
- Offer a concrete new development or occurrence that belongs in the existing story.
- Do not explain why it fits, analyze your reasoning, or enumerate future developments.
- Do not write escalation levels, a complete story arc, or multiple event ideas.
- Do not decide the player's actions, reactions, thoughts, or choices.
- Leave room for characters to respond naturally.
- Write entirely in English.
- Keep it a compact director's suggestion rather than a finished scene.
- Briefly describe the next possible event in concrete, objective terms.
- Do not write dialogue, internal monologues, elaborate atmosphere, or step-by-step narration.
- Give the player a useful idea they can use in the next scene.
- Provide an appropriate title.
- Aim for approximately 80–150 words in at most two short paragraphs.
- Avoid unnecessarily repeating events that already happened.

FORMAT:
# Event Title
[Specific description of the proposed event.]
`;

    const twistPrompt = `
You are the Story Director of an ongoing roleplay.

Develop ONE possible PLOT TWIST for the story's next development.

=== CURRENT STORY CONTEXT ===
${formattedContext}

=== REQUESTED DRAMATIC DIRECTION ===
${taskInstruction}
${getStoryDirectorDirectionInstruction(direction)}
${preferenceInstruction}
${diversityInstruction}

=== RULES FOR THE TWIST ===
- The twist must follow from the established story, feel surprising, and make sense in hindsight.
- Use existing characters, relationships, unresolved situations, clues, and plot threads.
- Prefer established information to newly invented facts.
- Do not invent important character backstory without evidence in the available context.
- Do not contradict existing lorebook facts.
- Change the story meaningfully or cast an established situation in a new light.
- A routine new event without a genuine turn or revelation is not enough.
- Do not dictate the player's response.
- Do not write a complete scene, dialogue, internal analysis, or a list of twists.
- Write entirely in English.
- Give one specific director's suggestion, around 80–150 words, in no more than two short paragraphs.

IMPORTANT:
The selected dramatic direction determines the TYPE of twist. It is not a keyword to insert literally.
The twist must fit the current story rather than feel forced.

FORMAT:
# Twist Title
[Specific description of the surprising twist.]
`;

    const prompt = kind === 'twist' ? twistPrompt : eventPrompt;
    const response =
        await generateDirectorResponse(prompt, maxTokens);

    console.log(
        '[Story Director] Suggestion slot generated:',
        {
            slot: slot.slot,
            task: slot.task,
            response,
            previousSuggestionCount: previousSuggestions.length,
            differentSuggestions: requireDifferentSuggestions,
        }
    );

    return {
        slot: slot.slot,
        task: slot.task,
        label: getStoryDirectorTaskLabel(slot.task),
        response,
    };
}

window.testStoryDirectorEventSlot = async () => {
    const slots = getStoryDirectorSlotSettings();

    const slot1 =
        slots.find(slot => slot.slot === 1) ?? {
            slot: 1,
            task: 'random',
        };

    return await generateEventForSlot(slot1);
};

window.testStoryDirectorAllEvents = async () => {
    return await generateStoryDirectorEvents();
};

async function generateStoryDirectorEvents(kind = 'event', direction = document.getElementById('story-director-direction')?.value ?? '') {
    console.log(
        '[Story Director] Generating all event slots...'
    );

    const slots =
        getStoryDirectorSlotSettings();

    if (!slots.length) {
        throw new Error(
            '[Story Director] No event slots configured.'
        );
    }

    const storyContext =
        await getStoryDirectorContext({
            chatLimit: 100,
        });

    const formattedContext =
        formatStoryDirectorContextForPrompt(
            storyContext
        );

    const differentSuggestions =
        Boolean(direction.trim()) || getStoryDirectorOption('differentSuggestions', 'story-director-different')
            || getStoryDirectorOption('avoidRecentIdeas', 'story-director-avoid-recent');

    const results = [];
    const previousSuggestions = [];

    for (const slot of slots) {
        try {
            const result =
                await generateEventForSlot(
                    slot,
                    formattedContext,
                    {
                        differentSuggestions,
                        previousSuggestions,
                    },
                    kind,
                    direction
                );

            results.push(result);

            if (differentSuggestions && result?.response) {
                previousSuggestions.push(result.response);
            }
        } catch (error) {
            // One empty or failed API call must not invalidate
            // the previously successful suggestion slots.
            console.warn(
                `[Story Director] Slot ${slot.slot} could not be generated. The next slot will still be attempted.`,
                error
            );

            results.push({
                slot: slot.slot,
                task: slot.task,
                label: getStoryDirectorTaskLabel(slot.task),
                response: 'No suggestion could be generated for this slot right now. Other slots were still processed.',
                failed: true,
            });
        }
    }

    console.log(
        '[Story Director] All event slots processed:',
        results
    );

    return results;
}

async function generateStoryDirectorUnstuck() {
    const maxTokens = getStoryDirectorGenerationTokens('unstuck');

    const storyContext =
        await getStoryDirectorContext({
            chatLimit: 100,
        });

    const formattedContext =
        formatStoryDirectorContextForPrompt(
            storyContext
        );

    const prompt = `
You are the Story Director of a long-running roleplay.

The story feels stuck. Consider the current state only as much as necessary to find concrete, natural ways to get the plot moving again.

=== CURRENT STORY CONTEXT ===
${formattedContext}

=== TASK ===
Create THREE clearly different ways to continue from the current situation.

IMPORTANT RULES:
- Start with established plot threads, unresolved situations, and relationships.
- Use lorebook and Doom Tracker details only where relevant.
- Do not rewrite events that already happened.
- Do not write complete scenes, dialogue, inner monologues, or entire plot arcs.
- Do not force decisions or reactions onto the player.
- Each option must take a genuinely distinct approach.
- Write entirely in English, and keep each option concise.

FORMAT:
# Option 1 – [Short Title]
[Concrete approach in 2–4 sentences.]

# Option 2 – [Short Title]
[Concrete approach in 2–4 sentences.]

# Option 3 – [Short Title]
[Concrete approach in 2–4 sentences.]
`;

    return await generateDirectorResponse(prompt, maxTokens);
}


function parseStoryDirectorDate(value) {
    const input = String(value ?? '').trim();
    const match = input.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-]([A-Za-z]{0,2}\d{1,6})$/);

    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]);
    const yearToken = match[3].toUpperCase();

    if (!Number.isInteger(day) || !Number.isInteger(month)) return null;

    let yearNumber;
    let yearPrefix = '';

    if (yearToken.startsWith('XX')) {
        yearPrefix = 'XX';
        yearNumber = Number(yearToken.slice(2));
    } else {
        yearNumber = Number(yearToken);
    }

    if (!Number.isInteger(yearNumber) || yearNumber < 0 || yearNumber > 999999) {
        return null;
    }

    const calculationYear = yearPrefix ? 2000 + yearNumber : yearNumber;

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return null;
    }

    const date = new Date(Date.UTC(calculationYear, month - 1, day));

    if (
        date.getUTCFullYear() !== calculationYear ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return {
        day,
        month,
        yearNumber,
        yearPrefix,
        calculationYear,
        date,
        original: String(day).padStart(2, '0') + '.' +
            String(month).padStart(2, '0') + '.' + yearToken,
    };
}

function formatStoryDirectorDate(dateInfo) {
    if (!dateInfo) return '';

    const year = dateInfo.yearPrefix
        ? 'XX' + String(dateInfo.yearNumber).padStart(2, '0')
        : String(dateInfo.yearNumber);

    return (
        String(dateInfo.day).padStart(2, '0') + '.' +
        String(dateInfo.month).padStart(2, '0') + '.' +
        year
    );
}

function addStoryDirectorDuration(start, amount, unit) {
    if (!start || !Number.isFinite(amount) || amount <= 0) return null;

    const result = {
        ...start,
        date: new Date(start.date.getTime()),
    };

    if (unit === 'days') {
        result.date.setUTCDate(result.date.getUTCDate() + amount);
    } else if (unit === 'weeks') {
        result.date.setUTCDate(result.date.getUTCDate() + amount * 7);
    } else if (unit === 'months') {
        result.date.setUTCMonth(result.date.getUTCMonth() + amount);
    } else if (unit === 'years') {
        result.date.setUTCFullYear(result.date.getUTCFullYear() + amount);
    } else {
        return null;
    }

    result.day = result.date.getUTCDate();
    result.month = result.date.getUTCMonth() + 1;

    if (start.yearPrefix) {
        result.yearNumber = result.date.getUTCFullYear() - 2000;
        result.yearPrefix = 'XX';
    } else {
        result.yearNumber = result.date.getUTCFullYear();
        result.yearPrefix = '';
    }

    return result;
}

function getStoryDirectorDateDifference(start, end) {
    if (!start || !end) return null;

    return Math.round(
        (end.date.getTime() - start.date.getTime()) / 86400000
    );
}

function createStoryDirectorTimeSkipDialog() {
    const overlay = document.createElement('div');
    overlay.id = 'story-director-timeskip-dialog';
    overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:100000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:16px',
        'background:rgba(0,0,0,.72)',
    ].join(';');

    const box = document.createElement('div');
    box.style.cssText = [
        'width:min(560px,100%)',
        'max-height:90vh',
        'overflow:auto',
        'padding:18px',
        'border-radius:12px',
        'background:var(--SmartThemeBlurTintColor,#202020)',
        'color:var(--SmartThemeBodyColor,#fff)',
        'box-sizing:border-box',
        'box-shadow:0 10px 40px rgba(0,0,0,.5)',
    ].join(';');

    box.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:14px;">
            <strong style="font-size:1.15em;">⏩ Time Skip</strong>
            <button type="button" data-ts-cancel style="font-size:1.2em;">×</button>
        </div>

        <label style="display:block;margin-bottom:6px;">Calculation method</label>
        <select data-ts-mode style="width:100%;margin-bottom:14px;">
            <option value="range">🗓️ Start and end dates</option>
            <option value="duration">⏩ Start date + duration</option>
        </select>

        <div data-ts-start-wrap>
            <label style="display:block;margin-bottom:6px;">Start date</label>
            <input data-ts-start type="text" placeholder="e.g. 14.05.XX12"
                style="width:100%;box-sizing:border-box;margin-bottom:12px;">
        </div>

        <div data-ts-end-wrap>
            <label style="display:block;margin-bottom:6px;">End date</label>
            <input data-ts-end type="text" placeholder="e.g. 20.10.XX12"
                style="width:100%;box-sizing:border-box;margin-bottom:12px;">
        </div>

        <div data-ts-duration-wrap style="display:none;">
            <label style="display:block;margin-bottom:6px;">Duration</label>
            <div style="display:flex;gap:8px;margin-bottom:12px;">
                <input data-ts-duration type="number" min="1" step="1" placeholder="e.g. 2"
                    style="flex:1;min-width:0;">
                <select data-ts-unit style="flex:1;min-width:0;">
                    <option value="days">Days</option>
                    <option value="weeks">Weeks</option>
                    <option value="months">Months</option>
                    <option value="years">Years</option>
                </select>
            </div>
        </div>

        <label style="display:block;margin-bottom:6px;">📝 Additional Instructions</label>
        <textarea data-ts-instructions rows="6"
            placeholder="e.g. Mitsuki has not returned yet. Do not focus on Mitsuki in the summary. She occasionally writes Naruto letters with photos and drawings."
            style="width:100%;box-sizing:border-box;resize:vertical;margin-bottom:14px;"></textarea>

        <div data-ts-error style="display:none;margin-bottom:12px;padding:8px;border-radius:8px;background:rgba(180,40,40,.25);"></div>

        <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button type="button" data-ts-cancel>Cancel</button>
            <button type="button" data-ts-submit>⏩ Create Time Skip</button>
        </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const mode = box.querySelector('[data-ts-mode]');
    const endWrap = box.querySelector('[data-ts-end-wrap]');
    const durationWrap = box.querySelector('[data-ts-duration-wrap]');
    const errorBox = box.querySelector('[data-ts-error]');

    const updateMode = () => {
        const durationMode = mode.value === 'duration';
        endWrap.style.display = durationMode ? 'none' : 'block';
        durationWrap.style.display = durationMode ? 'block' : 'none';
    };

    mode.addEventListener('change', updateMode);

    const close = () => overlay.remove();

    box.querySelectorAll('[data-ts-cancel]').forEach(button => {
        button.addEventListener('click', close);
    });

    return { overlay, box, mode, errorBox, close };
}

async function openStoryDirectorTimeSkipDialog() {
    const dialog = createStoryDirectorTimeSkipDialog();
    const box = dialog.box;

    const submit = box.querySelector('[data-ts-submit]');
    const startInput = box.querySelector('[data-ts-start]');
    const endInput = box.querySelector('[data-ts-end]');
    const durationInput = box.querySelector('[data-ts-duration]');
    const unitInput = box.querySelector('[data-ts-unit]');
    const instructionsInput = box.querySelector('[data-ts-instructions]');

    submit.addEventListener('click', async () => {
        const start = parseStoryDirectorDate(startInput.value);
        const mode = dialog.mode.value;

        let end = null;
        let durationText = '';

        if (!start) {
            dialog.errorBox.textContent =
                'Please enter a valid start date, e.g. 14.05.XX12.';
            dialog.errorBox.style.display = 'block';
            return;
        }

        if (mode === 'range') {
            end = parseStoryDirectorDate(endInput.value);

            if (!end) {
                dialog.errorBox.textContent =
                    'Please enter a valid end date, e.g. 20.10.XX12.';
                dialog.errorBox.style.display = 'block';
                return;
            }

            if (end.date <= start.date) {
                dialog.errorBox.textContent =
                    'The end date must be after the start date.';
                dialog.errorBox.style.display = 'block';
                return;
            }

            const days = getStoryDirectorDateDifference(start, end);
            durationText = days + ' day' + (days === 1 ? '' : 's');
        } else {
            const amount = Number(durationInput.value);

            if (!Number.isInteger(amount) || amount <= 0) {
                dialog.errorBox.textContent =
                    'Please enter a positive whole number for the duration.';
                dialog.errorBox.style.display = 'block';
                return;
            }

            end = addStoryDirectorDuration(start, amount, unitInput.value);

            if (!end) {
                dialog.errorBox.textContent =
                    'The duration could not be calculated.';
                dialog.errorBox.style.display = 'block';
                return;
            }

            const unitLabels = {
                days: amount === 1 ? 'day' : 'days',
                weeks: amount === 1 ? 'week' : 'weeks',
                months: amount === 1 ? 'month' : 'months',
                years: amount === 1 ? 'year' : 'years',
            };

            durationText = amount + ' ' + unitLabels[unitInput.value];
        }

        const startText = formatStoryDirectorDate(start);
        const endText = formatStoryDirectorDate(end);
        const extraInstructions = instructionsInput.value.trim();

        dialog.close();

        const maxTokens = getStoryDirectorGenerationTokens('timeskip');

        const storyContext =
            await getStoryDirectorContext({ chatLimit: 100 });

        const formattedContext =
            formatStoryDirectorContextForPrompt(storyContext);

        const prompt = `
You are the Story Director of a long-running roleplay.

A defined period of in-story time will be skipped. Summarize what plausibly happens DURING that period so the roleplay can continue at its end.

=== TIME PERIOD ===
Start: ${startText}
End: ${endText}
Duration: ${durationText}

=== CURRENT STORY CONTEXT ===
${formattedContext}

=== ADDITIONAL PLAYER INSTRUCTIONS ===
${extraInstructions || '(No additional instructions.)'}

These are firm conditions for the time skip, not optional ideas.
If a character is specified as not having returned, they must not return during this time skip.
If a character is not meant to be the focus, do not make them the central development.
Explicitly permitted off-screen events may still be included.

=== TASK ===
Create a compact yet useful summary of the relevant developments DURING the time skip.

Cover:
- Established character relationships and character growth
- Important events and the consequences of unresolved story threads
- Relevant changes in the world and surrounding circumstances
- The story's exact state at the end of the skipped period

For a long period, do not artificially invent an event for each week or month. Include only developments that matter to the story.

IMPORTANT RULES:
- Rely on established story context first.
- Use lorebook information and the Doom Tracker only when relevant.
- Do not rewrite already-established events or contradict character or lore facts.
- Do not write out a full scene, lengthy dialogue, or forced player decisions.
- The time skip ends on the exact specified end date.
- Write entirely in English.

FORMAT:
# ⏩ Time Skip: ${startText} → ${endText}

## ❤️ Relationships
[Relevant developments.]

## 🧠 Character Development
[Relevant developments.]

## ⚔️ Important Events
[Relevant events.]

## 🎯 Plot Threads & Consequences
[Changes to unresolved plot threads.]

## 🌍 World & Surroundings
[Relevant changes only.]

## 📌 State at the End
[Starting situation for the next roleplay reply.]
`;

        const result = document.getElementById('story-director-result');

        if (!result) return;

        storyDirectorState.eventGenerationInProgress = true;

        result.innerHTML = `
            <div class="story-director-placeholder">
                <strong>⏩ Calculating time skip...</strong>
                <p>🦉 The owl is exploring what happened during that time...</p>
            </div>
        `;

        try {
            const response =
                await generateDirectorResponse(prompt, maxTokens);

            result.innerHTML = '';

            const acceptInstruction = `
The time skip has already been fully applied.

The period from ${startText} to ${endText} (${durationText}) has NOW canonically passed.
The summary below records the relevant developments during that period.

Continue the roleplay immediately AT THE END of this time skip.
Do not retell the entire time skip or jump back to the starting date.
Continue respecting existing character, lorebook, and world information.
Write the continuation in English.

=== TIME-SKIP SUMMARY ===
`;

            result.appendChild(
                createStoryDirectorResultCard({
                    label: 'Time Skip ' + startText + ' → ' + endText,
                    response,
                    icon: '⏩',
                    acceptInstruction,
                })
            );
        } catch (error) {
            result.innerHTML = `
                <div class="story-director-placeholder">
                    <strong>❌ Time Skip Failed</strong>
                    <p>The owl could not generate the time skip right now.</p>
                    <small>Check the browser console for details.</small>
                </div>
            `;

            console.error(
                '[Story Director] Time Skip generation failed:',
                error
            );
        } finally {
            storyDirectorState.eventGenerationInProgress = false;
        }
    });
}

async function handleDirectorAction(action) {
    if (action === 'settings') {
        openSettings();
        return;
    }

    const result = document.getElementById('story-director-result');

    if (!result) {
        return;
    }

    const actionNames = {
        event: '🎲 Event',
        twist: '🌀 Twist',
        timeskip: '⏩ Time Skip',
        unstuck: '🆘 Unstick Story',
    };

    const name = actionNames[action] ?? 'Action';
    if (storyDirectorState.applyingSuggestion) return;

    if (action === 'event' || action === 'twist') {
        if (storyDirectorState.eventGenerationInProgress) {
            console.log(
                '[Story Director] Event generation already running.'
            );
            return;
        }

        storyDirectorState.eventGenerationInProgress = true;

        result.innerHTML = `
            <div class="story-director-placeholder">
                <strong>Generating ${name} suggestions...</strong>
                <p>🦉 The owl is thinking...</p>
            </div>
        `;

        try {
            const events =
                await generateStoryDirectorEvents(action);

            result.innerHTML = '';

            events.forEach(event => {
                result.appendChild(
                    createStoryDirectorResultCard({
                        label: event.label,
                        response: event.response,
                        failed: event.failed,
                        icon: action === 'twist' ? '🌀' : '🎲',
                    })
                );
            });
        } catch (error) {
            result.innerHTML = `
                <div class="story-director-placeholder">
                    <strong>❌ Generation Failed</strong>
                    <p>The owl could not generate ${action === 'twist' ? 'twists' : 'events'} right now.</p>
                    <small>Check the browser console for details.</small>
                </div>
            `;

            console.error(
                '[Story Director] Event generation failed:',
                error
            );
        } finally {
            storyDirectorState.eventGenerationInProgress = false;
        }

        return;
    }

    if (action === 'timeskip') {
        if (storyDirectorState.eventGenerationInProgress) {
            console.log('[Story Director] Another Director generation is already running.');
            return;
        }

        await openStoryDirectorTimeSkipDialog();
        return;
    }

    if (action === 'unstuck') {
        if (storyDirectorState.eventGenerationInProgress) {
            console.log(
                '[Story Director] Another Director generation is already running.'
            );
            return;
        }

        storyDirectorState.eventGenerationInProgress = true;

        result.innerHTML = `
            <div class="story-director-placeholder">
                <strong>🆘 The owl is looking for a way forward...</strong>
                <p>🦉 Analyzing the current story...</p>
            </div>
        `;

        try {
            const response =
                await generateStoryDirectorUnstuck();

            result.innerHTML = '';

            result.appendChild(
                createStoryDirectorResultCard({
                    label: 'Unstick Story',
                    response,
                    icon: '🆘',
                })
            );
        } catch (error) {
            result.innerHTML = `
                <div class="story-director-placeholder">
                    <strong>❌ Story Unstuck Failed</strong>
                    <p>The owl could not find a way forward right now.</p>
                    <small>Check the browser console for details.</small>
                </div>
            `;

            console.error(
                '[Story Director] Unstuck generation failed:',
                error
            );
        } finally {
            storyDirectorState.eventGenerationInProgress = false;
        }

        return;
    }

    result.innerHTML = `
        <div class="story-director-placeholder">
            <strong>${name}</strong>
            <p>This feature is coming next. 🦉</p>
            <small>The AI connection is already working.</small>
        </div>
    `;

    console.log(`[Story Director] Action: ${action}`);
}

function openSettings() {
    const section = document.querySelector('.story-director-section');
    const result = document.getElementById('story-director-result');
    const settings = document.getElementById('story-director-settings');

    if (!section || !result || !settings) {
        return;
    }

    section.style.display = 'none';
    result.style.display = 'none';
    settings.style.display = 'block';

    console.log('[Story Director] Settings opened');
}


function setupSettingsBackButton(panel) {
    const backButton = panel.querySelector('.story-director-back');
    const section = panel.querySelector('.story-director-section');
    const result = panel.querySelector('#story-director-result');
    const settings = panel.querySelector('#story-director-settings');

    if (!backButton || !section || !result || !settings) {
        return;
    }

    backButton.addEventListener('click', () => {
        settings.style.display = 'none';
        section.style.display = 'block';
        result.style.display = 'block';

        console.log('[Story Director] Settings closed');
    });
}

function setupSuggestionSettings(panel) {
    const slotCountSelect = panel.querySelector('#story-director-slot-count');
    const slotsContainer = panel.querySelector('#story-director-slots');

    if (!slotCountSelect || !slotsContainer) {
        return;
    }

    const tasks = [
        { value: 'random', label: '🎲 Random' },
        { value: 'positive', label: '✨ Positive Outcome' },
        { value: 'negative', label: '⚠️ Negative Outcome' },
        { value: 'gore', label: '🩸 Gore / Violence' },
        { value: 'danger', label: '💥 Danger' },
        { value: 'twist', label: '🌀 Twist' },
        { value: 'romance', label: '❤️ Romance' },
        { value: 'relationship', label: '🤝 Relationship' },
        { value: 'character', label: '🧠 Character Development' },
        { value: 'mystery', label: '🕵️ Mystery' },
        { value: 'horror', label: '👻 Horror' },
        { value: 'conflict', label: '⚔️ Conflict' },
        { value: 'humor', label: '😂 Humor' },
        { value: 'worldbuilding', label: '🌍 Worldbuilding' },
        { value: 'consequence', label: '🔗 Consequence' },
        { value: 'story-thread', label: '🎯 Plot Thread' }
    ];

    function renderSlots(savedSlots = null) {
    const count = Number(slotCountSelect.value);

    slotsContainer.innerHTML = '';

    for (let i = 1; i <= count; i++) {
        const slot = document.createElement('div');
        slot.className = 'story-director-slot';

        const label = document.createElement('label');
        label.className = 'story-director-setting-label';
        label.textContent = `Slot ${i}`;

        const select = document.createElement('select');
        select.className = 'story-director-select';
        select.dataset.slot = String(i);

        tasks.forEach(task => {
            const option = document.createElement('option');

            option.value = task.value;
            option.textContent = task.label;

            select.appendChild(option);
        });

        const savedSlot = savedSlots?.find(
            saved => saved.slot === i
        );

        if (savedSlot) {
            select.value = normalizeStoryDirectorTask(savedSlot.task);
        }

        slot.appendChild(label);
        slot.appendChild(select);
        slotsContainer.appendChild(slot);
    }
}
    

    slotCountSelect.addEventListener('change', () => {
    const currentSlots = Array.from(
        slotsContainer.querySelectorAll('.story-director-select')
    ).map(select => ({
        slot: Number(select.dataset.slot),
        task: select.value,
    }));

    renderSlots(currentSlots);
    saveSuggestionSettings(slotCountSelect, slotsContainer);
});

    slotsContainer.addEventListener('change', () => {
        saveSuggestionSettings(slotCountSelect, slotsContainer);
    });

        const checkboxIds = [
        'story-director-different',
        'story-director-story-threads',
        'story-director-avoid-recent',
    ];

    checkboxIds.forEach(id => {
        const checkbox = panel.querySelector(`#${id}`);

        if (checkbox) {
            checkbox.addEventListener('change', () => {
                saveSuggestionSettings(slotCountSelect, slotsContainer);
            });
        }
    });

    const tokenSelectIds = [
        'story-director-custom-tokens',
        'story-director-tokens-event',
        'story-director-tokens-twist',
        'story-director-tokens-timeskip',
        'story-director-tokens-unstuck',
    ];

    tokenSelectIds.forEach(id => {
        const element = panel.querySelector(`#${id}`);

        if (element) {
            element.addEventListener('change', () => {
                saveSuggestionSettings(slotCountSelect, slotsContainer);
            });
        }
    });

const savedSettings = loadSuggestionSettings();

if (savedSettings) {
    slotCountSelect.value = String(savedSettings.slotCount);
    renderSlots(savedSettings.slots);

    const differentSuggestions =
        panel.querySelector('#story-director-different');

    const preferStoryThreads =
        panel.querySelector('#story-director-story-threads');

    const avoidRecentIdeas =
        panel.querySelector('#story-director-avoid-recent');

    if (differentSuggestions) {
        differentSuggestions.checked =
            savedSettings.differentSuggestions ?? true;
    }

    if (preferStoryThreads) {
        preferStoryThreads.checked =
            savedSettings.preferStoryThreads ?? true;
    }

    if (avoidRecentIdeas) {
        avoidRecentIdeas.checked =
            savedSettings.avoidRecentIdeas ?? true;
    }

    const customTokens =
        panel.querySelector('#story-director-custom-tokens');

    if (customTokens) {
        customTokens.checked =
            savedSettings.customTokens ?? true;
    }

    const tokenSettings = savedSettings.tokens ?? {};

    const eventTokens =
        panel.querySelector('#story-director-tokens-event');

    const twistTokens =
        panel.querySelector('#story-director-tokens-twist');

    const timeskipTokens =
        panel.querySelector('#story-director-tokens-timeskip');

    const unstuckTokens =
        panel.querySelector('#story-director-tokens-unstuck');

    if (eventTokens) {
        eventTokens.value =
            String(tokenSettings.event ?? 800);
    }

    if (twistTokens) {
        twistTokens.value =
            String(tokenSettings.twist ?? 1400);
    }

    if (timeskipTokens) {
        timeskipTokens.value =
            String(tokenSettings.timeskip ?? 1200);
    }

    if (unstuckTokens) {
        unstuckTokens.value =
            String(tokenSettings.unstuck ?? 1600);
    }
} else {
    renderSlots();
}
}
function saveSuggestionSettings(slotCountSelect, slotsContainer) {
    const settings = {
        slotCount: Number(slotCountSelect.value),
        slots: [],

        differentSuggestions:
            document.getElementById('story-director-different')?.checked ?? true,

        preferStoryThreads:
            document.getElementById('story-director-story-threads')?.checked ?? true,

        avoidRecentIdeas:
            document.getElementById('story-director-avoid-recent')?.checked ?? true,
            
        customTokens:
            document.getElementById('story-director-custom-tokens')?.checked ?? true,

        tokens: {
            event:
                Number(document.getElementById('story-director-tokens-event')?.value) || 800,

            twist:
                Number(document.getElementById('story-director-tokens-twist')?.value) || 1400,

            timeskip:
                Number(document.getElementById('story-director-tokens-timeskip')?.value) || 1200,

            unstuck:
                Number(document.getElementById('story-director-tokens-unstuck')?.value) || 1600,
        },    
    };

    slotsContainer.querySelectorAll('.story-director-select').forEach(select => {
        settings.slots.push({
            slot: Number(select.dataset.slot),
            task: select.value,
        });
    });

    localStorage.setItem(
        'story-director-suggestion-settings',
        JSON.stringify(settings)
    );

    console.log('[Story Director] Suggestion settings saved:', settings);
}

function getStoryDirectorSlotSettings() {
    const saved =
        localStorage.getItem(
            'story-director-suggestion-settings'
        );

    if (!saved) {
        return [];
    }

    try {
        const settings = JSON.parse(saved);

        return Array.isArray(settings.slots)
            ? settings.slots.map(slot => ({ ...slot, task: normalizeStoryDirectorTask(slot.task) }))
            : [];
    } catch (error) {
        console.error(
            '[Story Director] Slot settings could not be read:',
            error
        );

        return [];
    }
}

window.testStoryDirectorSlotSettings = () => {
    return getStoryDirectorSlotSettings();
};

function getStoryDirectorTaskLabel(task) {
    const labels = {
        random: 'Random',
        positive: 'Positive Outcome',
        negative: 'Negative Outcome',
        gore: 'Gore / Violence',
        danger: 'Danger',
        twist: 'Twist',
        romance: 'Romance',
        relationship: 'Relationship',
        character: 'Character Development',
        mystery: 'Mystery',
        horror: 'Horror',
        conflict: 'Conflict',
        humor: 'Humor',
        worldbuilding: 'Worldbuilding',
        consequence: 'Consequence',
        'story-thread': 'Plot Thread',
    };

    task = normalizeStoryDirectorTask(task);
    return labels[task] || task || 'Random';
}

function getStoryDirectorTwistInstruction(task) {
    const instructions = {
        "random": "Choose a fitting dramatic twist direction based on the current story. This may involve romance, relationships, conflict, danger, mystery, character growth, consequences, or another appropriate kind of turn. Then develop one twist in that direction.",
        "positive": "Create an unexpectedly positive twist that credibly follows from the established story. It must not feel like a random gift.",
        "negative": "Create an unexpectedly negative twist, such as a setback, complication, loss, revelation, or new pressure. Keep it grounded in prior events.",
        "gore": "If appropriate to the story, create an unexpected twist involving violence or gore. It must serve a dramatic purpose rather than exist solely for shock.",
        "danger": "Reveal an unexpected danger or threat, or cast an existing threat in a new light.",
        "twist": "Introduce a particularly surprising turn that meaningfully changes how an established situation, piece of information, or expectation is understood.",
        "romance": "Create an unexpected romantic turn. Deepen established feelings, shift a previously understood relationship, reveal an emotional detail, or take a romantic situation in a new direction. Do not invent unsupported feelings or relationships.",
        "relationship": "Unexpectedly change or reframe a relationship between established characters, based on their prior interactions, conflicts, or shared experiences.",
        "character": "Reveal surprising character development that casts an established trait, memory, motivation, or decision in a new light.",
        "mystery": "Reinterpret an existing mystery, clue, or unanswered question. New information should change its meaning without inventing unsupported lore.",
        "horror": "Create an unexpectedly eerie or threatening turn where something familiar, seemingly safe, or harmless takes on a different meaning.",
        "conflict": "Unexpectedly shift or intensify an existing or emerging conflict based on characters' interests, actions, and relationships.",
        "humor": "Create a fitting, unexpectedly humorous twist without undermining established characterization.",
        "worldbuilding": "Reveal a surprising fact about the world, a location, group, its rules, or history, consistent with established worldbuilding.",
        "consequence": "Reveal an unexpected but retrospectively logical consequence of a previous event or choice.",
        "story-thread": "Surprisingly develop an existing unresolved plot thread; a minor detail or lingering question may gain new meaning."
};
    return instructions[normalizeStoryDirectorTask(task)] || instructions.random;
}

function getStoryDirectorTaskInstruction(task) {
    const instructions = {
        "random": "Choose an appropriate dramatic direction that naturally arises from the current story.",
        "positive": "Propose an event leading to a positive dramatic development without feeling artificial or implausible.",
        "negative": "Propose an event leading to a negative dramatic development, such as a setback, conflict, loss, pressure, or unforeseen complication.",
        "gore": "Where appropriate to the story, involve violence or gore as a meaningful dramatic element.",
        "danger": "Introduce a concrete danger or threat appropriate to the ongoing story.",
        "twist": "Include a surprising yet plausible turn emerging from previous events.",
        "romance": "Focus on romance and meaningfully develop an established relationship or emotional intimacy.",
        "relationship": "Develop or change a relationship between established characters.",
        "character": "Advance the personal development of an established character.",
        "mystery": "Advance an existing mystery, open question, or hidden detail.",
        "horror": "Include a fitting eerie or threatening development.",
        "conflict": "Advance an existing or newly arising conflict between characters or interests.",
        "humor": "Create a humorous situation fitting the characters and current story.",
        "worldbuilding": "Expand a relevant aspect of the world's rules, places, groups, or history.",
        "consequence": "Develop a logical consequence of an established event or decision.",
        "story-thread": "Pick up an already-established unresolved plot thread and continue it meaningfully."
};
    return instructions[normalizeStoryDirectorTask(task)] || instructions.random;
}

window.testStoryDirectorTaskInstruction = () => {
    const slots = getStoryDirectorSlotSettings();

    return slots.map(slot => ({
        slot: slot.slot,
        task: slot.task,
        instruction: getStoryDirectorTaskInstruction(slot.task),
    }));
};

window.testStoryDirectorTaskLabel = () => {
    const slots = getStoryDirectorSlotSettings();

    return slots.map(slot => ({
        slot: slot.slot,
        task: slot.task,
        label: getStoryDirectorTaskLabel(slot.task),
    }));
};

function loadSuggestionSettings() {
    const saved = localStorage.getItem(
        'story-director-suggestion-settings'
    );

    if (!saved) {
        return null;
    }

    try {
        const settings = JSON.parse(saved);
        if (Array.isArray(settings.slots)) settings.slots = settings.slots.map(slot => ({ ...slot, task: normalizeStoryDirectorTask(slot.task) }));
        return settings;
    } catch (error) {
        console.warn(
            '[Story Director] Could not load suggestion settings:',
            error
        );

        return null;
    }
}