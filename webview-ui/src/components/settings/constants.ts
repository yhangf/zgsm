import {
	ProviderName,
	ModelInfo,
	anthropicModels,
	bedrockModels,
	deepSeekModels,
	geminiModels,
	geminiCliModels,
	mistralModels,
	openAiNativeModels,
	vertexModels,
	zgsmProviderKey,
	xaiModels,
	groqModels,
	chutesModels,
} from "@roo/shared/api"
import i18next from "i18next"

export { REASONING_MODELS, PROMPT_CACHING_MODELS } from "@roo/shared/api"

export { AWS_REGIONS } from "@roo/shared/aws_regions"

export const MODELS_BY_PROVIDER: Partial<Record<ProviderName, Record<string, ModelInfo>>> = {
	anthropic: anthropicModels,
	bedrock: bedrockModels,
	deepseek: deepSeekModels,
	gemini: geminiModels,
	"gemini-cli": geminiCliModels,
	mistral: mistralModels,
	"openai-native": openAiNativeModels,
	vertex: vertexModels,
	xai: xaiModels,
	groq: groqModels,
	chutes: chutesModels,
}

export const PROVIDERS = [
	{ value: "openrouter", label: "OpenRouter" },
	{ value: "anthropic", label: "Anthropic" },
	{ value: "gemini", label: "Google Gemini" },
	{ value: "gemini-cli", label: "Gemini CLI" },
	{ value: "deepseek", label: "DeepSeek" },
	{ value: "openai-native", label: "OpenAI" },
	{ value: "openai", label: "OpenAI Compatible" },
	{ value: "vertex", label: "GCP Vertex AI" },
	{ value: "bedrock", label: "Amazon Bedrock" },
	{ value: "glama", label: "Glama" },
	{ value: "vscode-lm", label: "VS Code LM API" },
	{ value: "mistral", label: "Mistral" },
	{ value: "lmstudio", label: "LM Studio" },
	{ value: "ollama", label: "Ollama" },
	{ value: "unbound", label: "Unbound" },
	{ value: "requesty", label: "Requesty" },
	{ value: "human-relay", label: "Human Relay" },
	{ value: "xai", label: "xAI (Grok)" },
	{ value: "groq", label: "Groq" },
	{ value: "chutes", label: "Chutes AI" },
	{ value: "litellm", label: "LiteLLM" },
].sort((a, b) => a.label.localeCompare(b.label))

PROVIDERS.unshift({
	value: zgsmProviderKey,
	get label() {
		return i18next.t("settings:providers.zgsm")
	},
})

export const VERTEX_REGIONS = [
	{ value: "us-east5", label: "us-east5" },
	{ value: "us-central1", label: "us-central1" },
	{ value: "europe-west1", label: "europe-west1" },
	{ value: "europe-west4", label: "europe-west4" },
	{ value: "asia-southeast1", label: "asia-southeast1" },
]
