// Preserve WezTerm's numeric API and Herdr's workspace-qualified public handles.
export const isPaneId = (value) => /^(?:\d{1,6}|w[0-9A-HJKMNP-TV-Z]{1,13}:p[0-9A-HJKMNP-TV-Z]{1,13})(?![\s\S])/.test(String(value))
export const isWindowId = (value) => /^(?:\d{1,6}|w[0-9A-HJKMNP-TV-Z]{1,13})(?![\s\S])/.test(String(value))
// The end assertion above rejects final newlines too (unlike JavaScript $).
export const terminalId = (value) => /^\d+$/.test(String(value)) ? Number(value) : String(value)
