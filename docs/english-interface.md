# English-only interface

The browser interface always uses English. This includes initial HTML metadata, chat controls, model management and candidate selection, provider presets, settings, approval rules, built-in template editors, plugin previews and relevant service errors.

`web/src/i18n.tsx` exposes only the English UI pack. The language provider replaces saved browser language preferences with `en`, ignores requests to change the interface language and does not load other language packs. The language selection menu is removed. Core dictionaries and internal locale helpers remain available for compatibility and key validation; they do not change the rendered interface language.

`server/index.ts` uses English as its default and fixes socket locale requests to English. The compatibility `bilingual` helper in `server/i18n.ts` returns the English message without appending Chinese text.

Approval rules and subagent template editors display one set of English fields. Existing stored data is preserved until an explicit edit is saved. User messages, files, model identifiers, custom templates and external content may still contain any language; interface localization does not translate user content.

## Verification

The regression tests cover the English UI pack, ignored language-change requests, metadata, model-management copy, editor fields and English server relay messages. Locale key parity and unused-key checks remain enabled.

```sh
npm run typecheck
npx vitest run tests/unit/english-ui.test.ts tests/unit/server-i18n.test.ts tests/unit/locales.test.ts tests/unit/i18n-dead-keys.test.ts
```

Browser review should include model management, provider presets, candidate selection, settings, approval rules, template editors, plugin previews, terminal and Git views. Custom user content is outside the English-only interface requirement.
