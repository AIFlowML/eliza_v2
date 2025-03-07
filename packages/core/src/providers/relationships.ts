import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
	Relationship,
	UUID,
	Entity,
} from "../types.ts";

async function formatRelationships(
	runtime: IAgentRuntime,
	relationships: Relationship[],
) {
	// Sort relationships by interaction strength (descending)
	const sortedRelationships = relationships
		.filter((rel) => rel.metadata?.interactions)
		.sort(
			(a, b) =>
				(b.metadata?.interactions || 0) - (a.metadata?.interactions || 0),
		)
		.slice(0, 30); // Get top 30

	if (sortedRelationships.length === 0) {
		return "";
	}

	// Deduplicate target entity IDs to avoid redundant fetches
	const uniqueEntityIds = Array.from(
		new Set(sortedRelationships.map((rel) => rel.targetEntityId as UUID)),
	);

	// Fetch all required entities in a single batch operation
	const entities = await Promise.all(
		uniqueEntityIds.map((id) => runtime.getDatabaseAdapter().getEntityById(id)),
	);

	// Create a lookup map for efficient access
	const entityMap = new Map<string, Entity | null>();
	entities.forEach((entity, index) => {
		if (entity) {
			entityMap.set(uniqueEntityIds[index], entity);
		}
	});

	const formatMetadata = (metadata: any) => {
		return JSON.stringify(
			Object.entries(metadata)
				.map(
					([key, value]) =>
						`${key}: ${
							typeof value === "object" ? JSON.stringify(value) : value
						}`,
				)
				.join("\n"),
		);
	};

	// Format relationships using the entity map
	const formattedRelationships = sortedRelationships
		.map((rel) => {
			const targetEntityId = rel.targetEntityId as UUID;
			const entity = entityMap.get(targetEntityId);

			if (!entity) {
				return null;
			}

			const names = entity.names.join(" aka ");
			return `${names}\n${
				rel.tags ? rel.tags.join(", ") : ""
			}\n${formatMetadata(entity.metadata)}\n`;
		})
		.filter(Boolean);

	return formattedRelationships.join("\n");
}

const relationshipsProvider: Provider = {
	name: "RELATIONSHIPS",
	description:
		"Relationships between {{agentName}} and other people, or between other people that {{agentName}} has observed interacting with",
	get: async (runtime: IAgentRuntime, message: Memory) => {
		// Get all relationships for the current user
		const relationships = await runtime.getDatabaseAdapter().getRelationships({
			entityId: message.entityId,
		});

		if (!relationships || relationships.length === 0) {
			return {
				data: {
					relationships: [],
				},
				values: {
					relationships: "No relationships found.",
				},
				text: "No relationships found.",
			};
		}

		const formattedRelationships = await formatRelationships(
			runtime,
			relationships,
		);

		if (!formattedRelationships) {
			return {
				data: {
					relationships: [],
				},
				values: {
					relationships: "No relationships found.",
				},
				text: "No relationships found.",
			};
		}
		return {
			data: {
				relationships: formattedRelationships,
			},
			values: {
				relationships: formattedRelationships,
			},
			text: `# ${runtime.character.name} has observed ${message.content.senderName || message.content.name} interacting with these people:\n${formattedRelationships}`,
		};
	},
};

export { relationshipsProvider };
