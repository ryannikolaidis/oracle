// Exact observed model radios. Effort names and unknown GPT-6 variants are not model aliases.
export const ASTRA_MODEL_LABELS = ["GPT-6", "Latest", "最新", "최신"] as const;

// Older pickers expose only the version and effort in the closed composer pill.
export const ASTRA_COMPOSER_LABEL_PATTERN = "^6 ?(?:light|medium|high|extra high|pro)$";
