import { copyTemplate } from "@/src/utils/copy-template";
import { rawConfigSchema } from "@/src/utils/get-config";
import { handleError } from "@/src/utils/handle-error";
import { installPlugin } from "@/src/utils/install-plugin";
import { logger } from "@/src/utils/logger";
import { getAvailableDatabases, listPluginsByType } from "@/src/utils/registry";
import { runBunCommand } from "@/src/utils/run-bun";
import {
	createDatabaseTemplate,
	createEnvTemplate,
	createPluginsTemplate,
} from "@/src/utils/templates";
import chalk from "chalk";
import { Command } from "commander";
import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import prompts from "prompts";
import { z } from "zod";

const initOptionsSchema = z.object({
	dir: z.string().default("."),
	yes: z.boolean().default(false),
	type: z.enum(["project", "plugin"]).default("project"),
});

/**
 * Sets up the environment by creating .env and .env.example files in the target directory,
 * and optionally in the user's home directory if not in a project.
 *
 * @param {string} targetDir - The target directory where the .env files should be created.
 * @param {string} database - The name of the database to use in the environment files.
 * @returns {Promise<void>}
 */
async function setupEnvironment(targetDir: string, database: string) {
	const envPath = path.join(targetDir, ".env");
	const envExamplePath = path.join(targetDir, ".env.example");

	await fs.writeFile(envExamplePath, createEnvTemplate(database));

	if (!existsSync(envPath)) {
		await fs.copyFile(envExamplePath, envPath);
		logger.info("Created .env file");
	}

	// Also set up a global .env file in the user's home directory if we're not in a project
	const homeEnvDir = path.join(os.homedir(), ".eliza");
	const homeEnvPath = path.join(homeEnvDir, ".env");

	if (!existsSync(homeEnvDir)) {
		await fs.mkdir(homeEnvDir, { recursive: true });
	}

	if (!existsSync(homeEnvPath)) {
		await fs.writeFile(homeEnvPath, createEnvTemplate(database));
		logger.info("Created global .env file in ~/.eliza");
	}
}

/**
 * Async function to select client and additional plugins to install.
 * Retrieves list of client and plugin plugins, then prompts the user to select which ones to install.
 * @returns An array of selected client and additional plugins.
 */
async function selectPlugins() {
	const clients = await listPluginsByType("client");
	const plugins = await listPluginsByType("plugin");

	const result = await prompts([
		{
			type: "multiselect",
			name: "clients",
			message: "Select client plugins to install",
			choices: clients.map((name) => ({
				title: name,
				value: name,
			})),
		},
		{
			type: "multiselect",
			name: "plugins",
			message: "Select additional plugins",
			choices: plugins.map((name) => ({
				title: name,
				value: name,
			})),
		},
	]);

	return [...result.clients, ...result.plugins];
}

/**
 * Installs dependencies for the specified target directory, database, and selected plugins.
 * @param {string} targetDir - The directory where dependencies will be installed.
 * @param {string} database - The database for which the adapter will be installed.
 * @param {string[]} selectedPlugins - An array of selected plugins to be installed.
 * @returns {Promise<void>} A promise that resolves once all dependencies are installed.
 */
async function installDependencies(
	targetDir: string,
	database: string,
	selectedPlugins: string[],
) {
	logger.info("Installing dependencies...");

	// Install bun if not already installed
	try {
		await execa("npm", ["install", "-g", "bun"], {
			stdio: "inherit",
		});
	} catch (error) {
		logger.warn(
			"Failed to install bun globally. Continuing with installation...",
		);
	}

	// First just install basic dependencies
	try {
		await runBunCommand(["install"], targetDir);
		logger.success("Installed base dependencies");
	} catch (error) {
		logger.warn(`Initial dependency installation error: ${error.message}`);
	}

	// Install core package with latest version
	logger.info("Installing @elizaos/core using latest version...");
	try {
		await runBunCommand(["add", "@elizaos/core@latest"], targetDir);
		logger.success("Successfully installed @elizaos/core@latest");
	} catch (error) {
		logger.error(`Failed to install @elizaos/core@latest: ${error.message}`);
		// Continue with the process despite the error
	}

	// Install database adapter
	logger.info(`Installing database adapter for ${database}...`);
	try {
		await runBunCommand(
			["add", `@elizaos/adapter-${database}@latest`],
			targetDir,
		);
		logger.success(
			`Successfully installed @elizaos/adapter-${database}@latest`,
		);
	} catch (error) {
		logger.error(
			`Failed to install @elizaos/adapter-${database}: ${error.message}`,
		);
		// Continue with the process despite the error
	}

	// Install selected plugins
	if (selectedPlugins.length > 0) {
		logger.info(`Installing selected plugins: ${selectedPlugins.join(", ")}`);
		for (const plugin of selectedPlugins) {
			try {
				await installPlugin(plugin, targetDir);
			} catch (pluginError) {
				logger.error(
					`Failed to install plugin ${plugin}: ${pluginError.message}`,
				);
				// Continue with other plugins despite the error
			}
		}
	}
}

/**
 * Initialize a new project or plugin.
 *
 * @param {Object} opts - Options for initialization.
 * @param {string} opts.dir - Installation directory.
 * @param {boolean} opts.yes - Skip confirmation.
 * @param {string} opts.type - Type of template to use (project or plugin).
 *
 * @returns {Promise<void>} Promise that resolves once the initialization process is complete.
 */
export const init = new Command()
	.name("init")
	.description("Initialize a new project or plugin")
	.option("-d, --dir <dir>", "installation directory", ".")
	.option("-y, --yes", "skip confirmation", false)
	.option(
		"-t, --type <type>",
		"type of template to use (project or plugin)",
		"project",
	)
	.action(async (opts) => {
		try {
			const options = initOptionsSchema.parse(opts);
			// Try to find .env file by recursively checking parent directories
			const envPath = path.join(process.cwd(), ".env");

			let currentPath = envPath;
			let depth = 0;
			const maxDepth = 10;

			let postgresUrl = null;

			while (depth < maxDepth && currentPath.includes(path.sep)) {
				if (existsSync(currentPath)) {
					const env = readFileSync(currentPath, "utf8");
					const envVars = env.split("\n").filter((line) => line.trim() !== "");
					const postgresUrlLine = envVars.find((line) =>
						line.startsWith("POSTGRES_URL="),
					);
					if (postgresUrlLine) {
						postgresUrl = postgresUrlLine.split("=")[1].trim();
						break;
					}
				}

				// Move up one directory by getting the parent directory path
				// First get the directory containing the current .env file
				const currentDir = path.dirname(currentPath);
				// Then move up one directory from there
				const parentDir = path.dirname(currentDir);
				currentPath = path.join(parentDir, ".env");
				depth++;
			}
			// Prompt for project/plugin name
			const { name } = await prompts({
				type: "text",
				name: "name",
				message: `What would you like to name your ${options.type}?`,
				validate: (value) =>
					value.length > 0 || `${options.type} name is required`,
			});

			if (!name) {
				process.exit(0);
			}

			// Set up target directory
			const targetDir =
				options.dir === "." ? path.resolve(name) : path.resolve(options.dir);

			// Create or check directory
			if (!existsSync(targetDir)) {
				await fs.mkdir(targetDir, { recursive: true });
			} else {
				const files = await fs.readdir(targetDir);
				const isEmpty =
					files.length === 0 || files.every((f) => f.startsWith("."));

				if (!isEmpty && !options.yes) {
					const { proceed } = await prompts({
						type: "confirm",
						name: "proceed",
						message: "Directory is not empty. Continue anyway?",
						initial: false,
					});

					if (!proceed) {
						process.exit(0);
					}
				}
			}

			// For plugin initialization, we can simplify the process
			if (options.type === "plugin") {
				// Copy plugin template
				await copyTemplate("plugin", targetDir, name);

				// Change directory and install dependencies
				logger.info("Installing dependencies...");
				try {
					await runBunCommand(["install"], targetDir);
					logger.success("Dependencies installed successfully!");
				} catch (_error) {
					logger.warn(
						"Failed to install dependencies automatically. Please run 'bun install' manually.",
					);
				}

				logger.success("Plugin initialized successfully!");
				logger.info(`\nNext steps:
1. ${chalk.cyan(`run \`cd ${name}\``)} to navigate to your plugin directory
2. Update the plugin code in ${chalk.cyan("src/index.ts")} 
3. Run ${chalk.cyan("bun dev")} to start development
4. Run ${chalk.cyan("bun build")} to build your plugin`);
				return;
			}

			// For project initialization, continue with the regular flow
			// Get available databases and select one
			const availableDatabases = await getAvailableDatabases();

			const { database } = await prompts({
				type: "select",
				name: "database",
				message: "Select your database:",
				choices: availableDatabases.map((db) => ({
					title: db,
					value: db,
				})),
				initial: availableDatabases.indexOf("postgres"),
			});

			if (!database) {
				logger.error("No database selected");
				process.exit(1);
			}

			// Select plugins
			const selectedPlugins = await selectPlugins();

			// Copy project template
			await copyTemplate("project", targetDir, name);

			// Create a database directory in the user's home folder, similar to start.ts
			let dbPath = "../../pglite"; // Default fallback path
			try {
				// Get the user's home directory
				const homeDir = os.homedir();
				const elizaDir = path.join(homeDir, ".eliza");
				const elizaDbDir = path.join(elizaDir, "db");

				// Check if .eliza directory exists, create if not
				if (!existsSync(elizaDir)) {
					logger.info(`Creating .eliza directory at: ${elizaDir}`);
					await fs.mkdir(elizaDir, { recursive: true });
				}

				// Check if db directory exists in .eliza, create if not
				if (!existsSync(elizaDbDir)) {
					logger.info(`Creating db directory at: ${elizaDbDir}`);
					await fs.mkdir(elizaDbDir, { recursive: true });
				}

				// Use the db directory path
				dbPath = elizaDbDir;
				logger.info(`Using database directory: ${dbPath}`);
			} catch (error) {
				logger.warn(
					"Failed to create database directory in home directory, using fallback location:",
					error,
				);
				// On failure, use the fallback path
			}

			console.log(dbPath);
			console.log(postgresUrl);

			// Create project configuration
			const config = rawConfigSchema.parse({
				$schema: "https://elizaos.com/schema.json",
				database: {
					type: database,
					config:
						database === "postgres"
							? {
									url: postgresUrl || null,
								}
							: {
									path: dbPath,
								},
				},
				plugins: {
					registry:
						"https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/index.json",
					installed: [`@elizaos/plugin-${database}`, ...selectedPlugins],
				},
				paths: {
					knowledge: "./knowledge",
				},
			});

			// Write configuration
			await fs.writeFile(
				path.join(targetDir, "project.json"),
				JSON.stringify(config, null, 2),
			);

			// Set up src directory
			const srcDir = path.join(targetDir, "src");
			if (!existsSync(srcDir)) {
				await fs.mkdir(srcDir);
			}

			// Generate database and plugin files
			await fs.writeFile(
				path.join(srcDir, "database.ts"),
				createDatabaseTemplate(database),
			);

			await fs.writeFile(
				path.join(srcDir, "plugins.ts"),
				createPluginsTemplate(selectedPlugins),
			);

			// Set up environment
			await setupEnvironment(targetDir, database);

			// Create knowledge directory
			await fs.mkdir(path.join(targetDir, "knowledge"), { recursive: true });

			// Install dependencies
			await installDependencies(targetDir, database, selectedPlugins);

			logger.success("Project initialized successfully!");

			// Show next steps
			if (database !== "postgres") {
				logger.info(`\nNext steps:
1. ${chalk.cyan(`cd ${name}`)} to navigate to your project directory
2. Update ${chalk.cyan(".env")} with your database credentials
3. Run ${chalk.cyan("eliza plugins add")} to install additional plugins
4. Run ${chalk.cyan("eliza agent import")} to import an agent`);
			} else {
				logger.info(`\nNext steps:
1. ${chalk.cyan(`cd ${name}`)} to navigate to your project directory
2. Run ${chalk.cyan("eliza plugins add")} to install additional plugins
3. Run ${chalk.cyan("eliza agent import")} to import an agent`);
			}

			// exit
			process.exit(0);
		} catch (error) {
			handleError(error);
		}
	});
