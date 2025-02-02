/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Adam Voss. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';

import { workspace, ExtensionContext, extensions } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, NotificationType } from 'vscode-languageclient';
import { URI } from 'vscode-uri';
import { schemaContributor, CUSTOM_SCHEMA_REQUEST, CUSTOM_CONTENT_REQUEST } from './schema-contributor'

export interface ISchemaAssociations {
	[pattern: string]: string[];
}

namespace SchemaAssociationNotification {
	export const type: NotificationType<ISchemaAssociations, any> = new NotificationType('json/schemaAssociations');
}

namespace DynamicCustomSchemaRequestRegistration {
	export const type: NotificationType<{}, {}> = new NotificationType('yaml/registerCustomSchemaRequest');
}

const WORKSPACE_FILES_REQUEST = 'custom/workspace/yamlfiles';

export function activate(context: ExtensionContext) {
	// The YAML language server is implemented in node
	let serverModule = context.asAbsolutePath(path.join('node_modules', 'yaml-language-server', 'out', 'server', 'src', 'server.js'));

	// The debug options for the server
	let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run : { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for on disk and newly created YAML documents
		documentSelector: [
			{ language: 'yaml', scheme: 'file' },
			{ language: 'yaml', scheme: 'untitled' }
		],
		synchronize: {
			// Synchronize these setting sections with the server
			configurationSection: ['yaml', 'http.proxy', 'http.proxyStrictSSL'],
			// Notify the server about file changes to YAML and JSON files contained in the workspace
			fileEvents: [
				workspace.createFileSystemWatcher('**/*.?(e)y?(a)ml'),
				workspace.createFileSystemWatcher('**/*.json')
			]
		}
	};

	// Create the language client and start it
	let client = new LanguageClient('yaml', 'YAML Support', serverOptions, clientOptions);
	let disposable = client.start();

	// Push the disposable to the context's subscriptions so that the
	// client can be deactivated on extension deactivation
	context.subscriptions.push(disposable);

	client.onReady().then(() => {
		// Send a notification to the server with any YAML schema associations in all extensions
		client.sendNotification(SchemaAssociationNotification.type, getSchemaAssociation(context));
		// If the extensions change, fire this notification again to pick up on any association changes
		extensions.onDidChange(_ => {
			client.sendNotification(SchemaAssociationNotification.type, getSchemaAssociation(context));
		});
		// Tell the server that the client is ready to provide custom schema content
		client.sendNotification(DynamicCustomSchemaRequestRegistration.type);
		// If the server asks for custom schema content, get it and send it back
		client.onRequest(CUSTOM_SCHEMA_REQUEST, (resource: string) => {
			return schemaContributor.requestCustomSchema(resource);
		});
		client.onRequest(CUSTOM_CONTENT_REQUEST, (uri: string) => {
			return schemaContributor.requestCustomSchemaContent(uri);
		});
		// If the server asks, find all YAML files in the workspace and return an array of paths
		client.onRequest(WORKSPACE_FILES_REQUEST, () => {
			return workspace.findFiles('**/*.{ey,y}{m,am}l')
							.then(yamlFiles => yamlFiles.map(yamlFile => yamlFile.fsPath),
								  error => console.error('Failed to search workspace for YAML files: ' + error));
		});
	});

	return schemaContributor;
}

function getSchemaAssociation(context: ExtensionContext): ISchemaAssociations {
	let associations: ISchemaAssociations = {};
	// Scan all extensions
	extensions.all.forEach(extension => {
		let packageJSON = extension.packageJSON;
		// Look for yamlValidation contribution point in the package.json
		if (packageJSON && packageJSON.contributes && packageJSON.contributes.yamlValidation) {
			let yamlValidation = packageJSON.contributes.yamlValidation;
			// If the extension provides YAML validation
			if (Array.isArray(yamlValidation)) {
				yamlValidation.forEach(jv => {
					// Get the extension's YAML schema associations
					let { fileMatch, url } = jv;

					if (fileMatch && url) {
						// Convert relative file paths to absolute file URIs
						if (url[0] === '.' && url[1] === '/') {
							url = URI.file(path.join(extension.extensionPath, url)).toString();
						}
						// Replace path variables
						if (fileMatch[0] === '%') {
							fileMatch = fileMatch.replace(/%APP_SETTINGS_HOME%/, '/User');
							fileMatch = fileMatch.replace(/%APP_WORKSPACES_HOME%/, '/Workspaces');
						} else if (fileMatch.charAt(0) !== '/' && !fileMatch.match(/\w+:\/\//)) {
							fileMatch = '/' + fileMatch;
						}
						// Create a file-schema association
						let association = associations[fileMatch];

						if (!association) {
							association = [];
							associations[fileMatch] = association;
						}
						// Store the file-schema association
						association.push(url);
					}
				});
			}
		}
	});

	return associations;
}
