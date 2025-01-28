import { isArtifactCodeContent } from "@/lib/artifact_content_types";
import { CustomModelConfig } from "@/types";
import { BaseStore, LangGraphRunnableConfig } from "@langchain/langgraph";
import { initChatModel } from "langchain/chat_models/universal";
import { ArtifactCodeV3, ArtifactMarkdownV3, Reflections } from "../types";
import { ContextDocument } from "@/hooks/useAssistants";
import pdfParse from "pdf-parse";
import { MessageContentComplex } from "@langchain/core/messages";
import {
  LANGCHAIN_USER_ONLY_MODELS,
  TEMPERATURE_EXCLUDED_MODELS,
} from "@/constants";
import { createClient, Session, User } from "@supabase/supabase-js";

export const formatReflections = (
  reflections: Reflections,
  extra?: {
    /**
     * Will only include the style guidelines in the output.
     * If this is set to true, you may not specify `onlyContent` as `true`.
     */
    onlyStyle?: boolean;
    /**
     * Will only include the content in the output.
     * If this is set to true, you may not specify `onlyStyle` as `true`.
     */
    onlyContent?: boolean;
  }
): string => {
  if (extra?.onlyStyle && extra?.onlyContent) {
    throw new Error(
      "Cannot specify both `onlyStyle` and `onlyContent` as true."
    );
  }

  let styleRulesArr = reflections.styleRules;
  let styleRulesStr = "No style guidelines found.";
  if (!Array.isArray(styleRulesArr)) {
    try {
      styleRulesArr = JSON.parse(styleRulesArr);
      styleRulesStr = styleRulesArr.join("\n- ");
    } catch (_) {
      console.error(
        "FAILED TO PARSE STYLE RULES. \n\ntypeof:",
        typeof styleRulesArr,
        "\n\nstyleRules:",
        styleRulesArr
      );
    }
  }

  let contentRulesArr = reflections.content;
  let contentRulesStr = "No memories/facts found.";
  if (!Array.isArray(contentRulesArr)) {
    try {
      contentRulesArr = JSON.parse(contentRulesArr);
      contentRulesStr = contentRulesArr.join("\n- ");
    } catch (_) {
      console.error(
        "FAILED TO PARSE CONTENT RULES. \n\ntypeof:",
        typeof contentRulesArr,
        "\ncontentRules:",
        contentRulesArr
      );
    }
  }

  const styleString = `The following is a list of style guidelines previously generated by you:
<style-guidelines>
- ${styleRulesStr}
</style-guidelines>`;
  const contentString = `The following is a list of memories/facts you previously generated about the user:
<user-facts>
- ${contentRulesStr}
</user-facts>`;

  if (extra?.onlyStyle) {
    return styleString;
  }
  if (extra?.onlyContent) {
    return contentString;
  }

  return styleString + "\n\n" + contentString;
};

export async function getFormattedReflections(
  config: LangGraphRunnableConfig
): Promise<string> {
  if (!config.store) {
    return "No reflections found.";
  }
  const store = ensureStoreInConfig(config);
  const assistantId = config.configurable?.assistant_id;
  if (!assistantId) {
    throw new Error("`assistant_id` not found in configurable");
  }
  const memoryNamespace = ["memories", assistantId];
  const memoryKey = "reflection";
  const memories = await store.get(memoryNamespace, memoryKey);
  const memoriesAsString = memories?.value
    ? formatReflections(memories.value as Reflections)
    : "No reflections found.";

  return memoriesAsString;
}

export const ensureStoreInConfig = (
  config: LangGraphRunnableConfig
): BaseStore => {
  if (!config.store) {
    throw new Error("`store` not found in config");
  }
  return config.store;
};

export const formatArtifactContent = (
  content: ArtifactMarkdownV3 | ArtifactCodeV3,
  shortenContent?: boolean
): string => {
  let artifactContent: string;

  if (isArtifactCodeContent(content)) {
    artifactContent = shortenContent
      ? content.code?.slice(0, 500)
      : content.code;
  } else {
    artifactContent = shortenContent
      ? content.fullMarkdown?.slice(0, 500)
      : content.fullMarkdown;
  }
  return `Title: ${content.title}\nArtifact type: ${content.type}\nContent: ${artifactContent}`;
};

export const formatArtifactContentWithTemplate = (
  template: string,
  content: ArtifactMarkdownV3 | ArtifactCodeV3,
  shortenContent?: boolean
): string => {
  return template.replace(
    "{artifact}",
    formatArtifactContent(content, shortenContent)
  );
};

export const getModelConfig = (
  config: LangGraphRunnableConfig
): {
  modelName: string;
  modelProvider: string;
  modelConfig?: CustomModelConfig;
  azureConfig?: {
    azureOpenAIApiKey: string;
    azureOpenAIApiInstanceName: string;
    azureOpenAIApiDeploymentName: string;
    azureOpenAIApiVersion: string;
    azureOpenAIBasePath?: string;
  };
  apiKey?: string;
  baseUrl?: string;
} => {
  const customModelName = config.configurable?.customModelName as string;
  if (!customModelName) throw new Error("Model name is missing in config.");

  const modelConfig = config.configurable?.modelConfig as CustomModelConfig;

  if (customModelName.startsWith("azure/")) {
    const actualModelName = customModelName.replace("azure/", "");
    return {
      modelName: actualModelName,
      modelProvider: "azure_openai",
      azureConfig: {
        azureOpenAIApiKey: process.env._AZURE_OPENAI_API_KEY || "",
        azureOpenAIApiInstanceName:
          process.env._AZURE_OPENAI_API_INSTANCE_NAME || "",
        azureOpenAIApiDeploymentName:
          process.env._AZURE_OPENAI_API_DEPLOYMENT_NAME || "",
        azureOpenAIApiVersion:
          process.env._AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
        azureOpenAIBasePath: process.env._AZURE_OPENAI_API_BASE_PATH,
      },
    };
  }

  const providerConfig = {
    modelName: customModelName,
    modelConfig,
  };

  if (customModelName.includes("gpt-") || customModelName.includes("o1")) {
    return {
      ...providerConfig,
      modelProvider: "openai",
      apiKey: process.env.OPENAI_API_KEY,
    };
  }
  if (customModelName.includes("claude-")) {
    return {
      ...providerConfig,
      modelProvider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY,
    };
  }
  if (customModelName.includes("fireworks/")) {
    return {
      ...providerConfig,
      modelProvider: "fireworks",
      apiKey: process.env.FIREWORKS_API_KEY,
    };
  }
  if (customModelName.includes("gemini-")) {
    return {
      ...providerConfig,
      modelProvider: "google-genai",
      apiKey: process.env.GOOGLE_API_KEY,
    };
  }
  if (customModelName.startsWith("ollama-")) {
    return {
      modelName: customModelName.replace("ollama-", ""),
      modelProvider: "ollama",
      baseUrl:
        process.env.OLLAMA_API_URL || "http://host.docker.internal:11434",
    };
  }

  throw new Error("Unknown model provider");
};

export function optionallyGetSystemPromptFromConfig(
  config: LangGraphRunnableConfig
): string | undefined {
  return config.configurable?.systemPrompt as string | undefined;
}

async function getUserFromConfig(
  config: LangGraphRunnableConfig
): Promise<User | undefined> {
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    return undefined;
  }
  const accessToken = (
    config.configurable?.supabase_session as Session | undefined
  )?.access_token;
  if (!accessToken) {
    return undefined;
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  const authRes = await supabase.auth.getUser(accessToken);
  return authRes.data.user || undefined;
}

export async function getModelFromConfig(
  config: LangGraphRunnableConfig,
  extra?: {
    temperature?: number;
    maxTokens?: number;
  }
) {
  const {
    modelName,
    modelProvider,
    azureConfig,
    apiKey,
    baseUrl,
    modelConfig,
  } = getModelConfig(config);
  const { temperature = 0.5, maxTokens } = {
    temperature: modelConfig?.temperatureRange.current,
    maxTokens: modelConfig?.maxTokens.current,
    ...extra,
  };

  const isLangChainUserModel = LANGCHAIN_USER_ONLY_MODELS.some(
    (m) => m === modelName
  );
  if (isLangChainUserModel) {
    const user = await getUserFromConfig(config);
    if (!user) {
      throw new Error(
        "Unauthorized. Can not use LangChain only models without a user."
      );
    }
    if (!user.email?.endsWith("@langchain.dev")) {
      throw new Error(
        "Unauthorized. Can not use LangChain only models without a user with a @langchain.dev email."
      );
    }
  }

  const includeStandardParams = !TEMPERATURE_EXCLUDED_MODELS.some(
    (m) => m === modelName
  );

  return await initChatModel(modelName, {
    modelProvider,
    // Certain models (e.g., OpenAI o1) do not support passing the temperature param.
    ...(includeStandardParams && { temperature }),
    ...(includeStandardParams
      ? { maxTokens }
      : { max_completion_tokens: maxTokens }),
    ...(!includeStandardParams && { stream: false }),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(azureConfig != null
      ? {
          azureOpenAIApiKey: azureConfig.azureOpenAIApiKey,
          azureOpenAIApiInstanceName: azureConfig.azureOpenAIApiInstanceName,
          azureOpenAIApiDeploymentName:
            azureConfig.azureOpenAIApiDeploymentName,
          azureOpenAIApiVersion: azureConfig.azureOpenAIApiVersion,
          azureOpenAIBasePath: azureConfig.azureOpenAIBasePath,
        }
      : {}),
  });
}

async function convertPDFToText(base64PDF: string) {
  try {
    // Convert base64 to buffer
    const pdfBuffer = Buffer.from(base64PDF, "base64");

    // Parse PDF
    const data = await pdfParse(pdfBuffer);

    // Get text content
    const text = data.text;

    return text;
  } catch (error) {
    console.error("Error converting PDF to text:", error);
    throw error;
  }
}

export async function createContextDocumentMessagesAnthropic(
  config: LangGraphRunnableConfig,
  options?: { nativeSupport: boolean }
) {
  if (!config.configurable?.documents) {
    return [];
  }

  const messagesPromises = (
    config.configurable?.documents as ContextDocument[]
  ).map(async (doc) => {
    if (doc.type.includes("pdf") && options?.nativeSupport) {
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: doc.type,
          data: doc.data,
        },
      };
    }

    let text = "";
    if (doc.type.includes("pdf") && !options?.nativeSupport) {
      text = await convertPDFToText(doc.data);
    } else if (doc.type.startsWith("text/")) {
      text = atob(doc.data);
    }

    return {
      type: "text",
      text,
    };
  });

  return await Promise.all(messagesPromises);
}

export function createContextDocumentMessagesGemini(
  config: LangGraphRunnableConfig
) {
  if (!config.configurable?.documents) {
    return [];
  }

  return (config.configurable?.documents as ContextDocument[]).map((doc) => {
    if (doc.type.includes("pdf")) {
      return {
        mime_type: doc.type,
        data: doc.data,
      };
    } else if (doc.type.startsWith("text/")) {
      return {
        type: "text",
        text: atob(doc.data),
      };
    }
    throw new Error("Unsupported document type: " + doc.type);
  });
}

export async function createContextDocumentMessagesOpenAI(
  config: LangGraphRunnableConfig
) {
  if (!config.configurable?.documents) {
    return [];
  }

  const messagesPromises = (
    config.configurable?.documents as ContextDocument[]
  ).map(async (doc) => {
    let text = "";

    if (doc.type.includes("pdf")) {
      text = await convertPDFToText(doc.data);
    } else if (doc.type.startsWith("text/")) {
      text = atob(doc.data);
    }

    return {
      type: "text",
      text,
    };
  });

  return await Promise.all(messagesPromises);
}

export async function createContextDocumentMessages(
  config: LangGraphRunnableConfig
) {
  const { modelProvider, modelName } = getModelConfig(config);
  let contextDocumentMessages: Record<string, any>[] = [];
  if (modelProvider === "openai") {
    contextDocumentMessages = await createContextDocumentMessagesOpenAI(config);
  } else if (modelProvider === "anthropic") {
    const nativeSupport = modelName.includes("3-5-sonnet");
    contextDocumentMessages = await createContextDocumentMessagesAnthropic(
      config,
      {
        nativeSupport,
      }
    );
  } else if (modelProvider === "gemini") {
    contextDocumentMessages = createContextDocumentMessagesGemini(config);
  }

  if (!contextDocumentMessages.length) return [];

  let contextMessages: Array<{
    role: "user";
    content: MessageContentComplex[];
  }> = [];
  if (contextDocumentMessages?.length) {
    contextMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Use the file(s) and/or text below as context when generating your response.",
          },
          ...contextDocumentMessages,
        ],
      },
    ];
  }

  return contextMessages;
}
