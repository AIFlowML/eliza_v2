import { splitChunks } from "./parsing.ts";
import logger from "./logger.ts";
import type { AgentRuntime } from "./runtime.ts";
import { type KnowledgeItem, type Memory, ModelClass, type UUID } from "./types.ts";
import { stringToUuid } from "./uuid.ts";

async function get(
    runtime: AgentRuntime,
    message: Memory
): Promise<KnowledgeItem[]> {
    // Add validation for message
    if (!message?.content?.text) {
        logger.warn("Invalid message for knowledge query:", {
            message,
            content: message?.content,
            text: message?.content?.text,
        });
        return [];
    }

    const processed = preprocess(message.content.text);
    logger.debug("Knowledge query:", {
        original: message.content.text,
        processed,
        length: processed?.length,
    });

    // Validate processed text
    if (!processed || processed.trim().length === 0) {
        logger.warn("Empty processed text for knowledge query");
        return [];
    }

    const embedding = await runtime.useModel(ModelClass.TEXT_EMBEDDING, processed);
    const fragments = await runtime.knowledgeManager.searchMemories(
        {
            embedding,
            roomId: message.agentId,
            count: 5,
            match_threshold: 0.1,
        }
    );

    const uniqueSources = [
        ...new Set(
            fragments.map((memory) => {
                logger.log(
                    `Matched fragment: ${memory.content.text} with similarity: ${memory.similarity}`
                );
                return memory.content.source;
            })
        ),
    ];

    const knowledgeDocuments = await Promise.all(
        uniqueSources.map((source) =>
            runtime.documentsManager.getMemoryById(source as UUID)
        )
    );

    return knowledgeDocuments
        .filter((memory) => memory !== null)
        .map((memory) => ({ id: memory.id, content: memory.content }));
}

async function set(runtime: AgentRuntime, item: KnowledgeItem) {
    // First store the document
    const documentMemory: Memory = {
        id: item.id,
        agentId: runtime.agentId,
        roomId: runtime.agentId,
        userId: runtime.agentId,
        content: item.content,
        metadata: {
            type: 'document',
            timestamp: Date.now()
        }
    };
    
    await runtime.documentsManager.createMemory(documentMemory);

    // Then create fragments
    const fragments = await splitChunks(item.content.text);
    
    for (let i = 0; i < fragments.length; i++) {
        const fragmentMemory: Memory = {
            id: stringToUuid(`${item.id}-fragment-${i}`),
            agentId: runtime.agentId,
            roomId: runtime.agentId,
            userId: runtime.agentId,
            content: { text: fragments[i] },
            metadata: {
                type: 'fragment',
                documentId: item.id,
                position: i,
                timestamp: Date.now()
            }
        };
        
        await runtime.knowledgeManager.createMemory(fragmentMemory);
    }
}

export function preprocess(content: string): string {
    logger.debug("Preprocessing text:", {
        input: content,
        length: content?.length,
    });

    if (!content || typeof content !== "string") {
        logger.warn("Invalid input for preprocessing");
        return "";
    }

    return (
        content
            // Remove code blocks and their content
            .replace(/```[\s\S]*?```/g, "")
            // Remove inline code
            .replace(/`.*?`/g, "")
            // Convert headers to plain text with emphasis
            .replace(/#{1,6}\s*(.*)/g, "$1")
            // Remove image links but keep alt text
            .replace(/!\[(.*?)\]\(.*?\)/g, "$1")
            // Remove links but keep text
            .replace(/\[(.*?)\]\(.*?\)/g, "$1")
            // Simplify URLs: remove protocol and simplify to domain+path
            .replace(/(https?:\/\/)?(www\.)?([^\s]+\.[^\s]+)/g, "$3")
            // Remove Discord mentions specifically
            .replace(/<@[!&]?\d+>/g, "")
            // Remove HTML tags
            .replace(/<[^>]*>/g, "")
            // Remove horizontal rules
            .replace(/^\s*[-*_]{3,}\s*$/gm, "")
            // Remove comments
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/.*/g, "")
            // Normalize whitespace
            .replace(/\s+/g, " ")
            // Remove multiple newlines
            .replace(/\n{3,}/g, "\n\n")
            // Remove special characters except those common in URLs
            .replace(/[^a-zA-Z0-9\s\-_./:?=&]/g, "")
            .trim()
            .toLowerCase()
    );
}

export default {
    get,
    set,
    preprocess,
};
