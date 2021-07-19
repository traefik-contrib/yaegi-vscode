import { spawn } from 'child_process';
import vscode = require('vscode');
import os = require('os');
import path = require('path');
import fs = require('fs');
import * as Go from './go/export';

const fsp = fs.promises;
let GoExtension: Go.ExtensionAPI;

function output() {
	const self = <(() => vscode.OutputChannel) & { channel?: vscode.OutputChannel }>output;
	if (self.channel) return self.channel;
	return self.channel = vscode.window.createOutputChannel('Yaegi');
}

export async function activate(context: vscode.ExtensionContext) {
	const goExt = await vscode.extensions.getExtension('golang.go-nightly');
	if (!goExt) throw new Error(`Requires Go extension`);

	GoExtension = await goExt.activate();
	if (!GoExtension) throw new Error(`Requires recent Go extension >= v0.28.0`);

	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('yaegi', new YaegiDebugConfigurationProvider()));
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('yaegi', new YaegiDebugAdapterDescriptorFactory()));
}

export function deactivate() {
	deleteTempDir();
}

interface AttachConfiguration extends vscode.DebugConfiguration {
	type: 'yaegi';
	request: 'launch';
	socket: string;
}

interface LaunchConfiguration extends vscode.DebugConfiguration {
	type: 'yaegi';
	request: 'launch';

	program: string;
	cwd?: string;
	args?: string[];
	env?: { [key: string]: string };

	stopAtEntry?: boolean;
	showProtocolLog?: boolean;
}

class YaegiDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
	resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
		if (config.program || config.request == 'attach')
			return config;

		if (Object.keys(config).length > 0 && !config.program)
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return null;
			});

		// launch without configuration
		if (vscode.window.activeTextEditor?.document.languageId != 'go')
			return vscode.window.showInformationMessage("Select a Go file to debug").then(_ => {
				return null;
			});

		return {
			type: 'yaegi',
			name: 'Launch current file',
			request: 'launch',
			program: '${file}',
		};
	}
}

class YaegiDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
	async createDebugAdapterDescriptor(session: vscode.DebugSession): Promise<vscode.DebugAdapterDescriptor|undefined> {
		if (session.configuration.request == 'attach') {
			const config = <AttachConfiguration>session.configuration;
			return new vscode.DebugAdapterNamedPipeServer(config.socket);
		}

		const modeStdio = false;

		const { binPath, args = [], env = {} } = await getYaegiDapBin(session.workspaceFolder?.uri);

		const socket = await getTempFilePath(`debug-${randomName(10)}.socket`);
		args.push('--mode', 'net', '--addr', `unix://${socket}`);

		const config = session.configuration as LaunchConfiguration;
		if (config.stopAtEntry) args.push('--stop-at-entry');
		if (config.showProtocolLog) args.push('--log', '-');

		args.push(config.program, '--');
		if (config.args) args.push(...config.args);
		if (config.env) Object.assign(env, config.env);


		output().appendLine(`$ ${binPath} ${args.join(' ')} ${env}`);

		const proc = spawn(binPath, args, {
			cwd: config.cwd,
			env: env as NodeJS.ProcessEnv,
			stdio: 'pipe',
		});

		if (!modeStdio) proc.stdout.on('data', b => output().append(b.toString()));
		proc.stderr.on('data', b => output().append(b.toString()));

		let stop: () => void;
		const didStop = Symbol('stopped');
		const stopped = new Promise<Symbol>(r => stop = () => r(didStop));

		stopped.then(() => fsp.unlink(socket)).catch(() => {});

		proc.on('exit', async code => {
			stop();
			vscode.debug.stopDebugging(session);
			output().appendLine(`Exited with code ${code}`);
			if (code) output().show();
		});

		proc.on('error', async (err: any) => {
			stop();
			vscode.debug.stopDebugging(session);
			output().appendLine(`Exited with error ${err}`);
			output().show();
		});

		for (;;) {
			const r = await Promise.race([exists(socket), stopped]);
			if (r == true || r == didStop) break;
			await new Promise(r => setTimeout(r, 10));
		}

		return new vscode.DebugAdapterNamedPipeServer(socket);
	}
}

async function getYaegiDapBin(uri?: vscode.Uri) {
	let inv = GoExtension.settings.getExecutionCommand('yaegi-dap', uri);
	if (!inv) throw new Error('Cannot find yaegi-dap');
	if (await exists(inv.binPath)) return inv;

	const tool: Go.ToolAtVersion = {
		name: 'yaegi-dap',
		importPath: 'gitlab.com/ethan.reesor/vscode-notebooks/yaegi-dap/cmd/yaegi-dap',
		modulePath: 'gitlab.com/ethan.reesor/vscode-notebooks/yaegi-dap',
		isImportant: true,
		description: 'Yaegi Debugger',
	};
	await vscode.commands.executeCommand('go.tools.install', [tool]);

	inv = GoExtension.settings.getExecutionCommand('yaegi-dap', uri);
	if (!inv) throw new Error('Cannot find yaegi-dap');
	if (await exists(inv.binPath)) return inv;

	throw new Error('Unable to locate or install Yaegi');
}

async function exists(file: string): Promise<boolean> {
    try {
        await fsp.stat(file);
        return true;
    } catch (error) {
		const e = <any>error;
        if (e.code && e.code == 'ENOENT')
            return false;
        throw error;
    }
}

let tmpDir: string | undefined;
export async function getTempFilePath(name: string): Promise<string> {
	if (!tmpDir)
		tmpDir = await fsp.mkdtemp(os.tmpdir() + path.sep + 'vscode-yaegi');

	if (!await exists(tmpDir))
		await fsp.mkdir(tmpDir);

	return path.normalize(path.join(tmpDir!, name));
}

export async function deleteTempDir() {
    if (!tmpDir) return;
    if (!await exists(tmpDir)) return;

    await rm(tmpDir);

    async function rm(dir: string) {
        const files = await fsp.readdir(dir);
        await Promise.all(files.map(async (name: string) => {
            const p = path.join(dir, name);
            const stat = await fsp.lstat(p);
            if (stat.isDirectory())
                await rm(p);
            else
                await fsp.unlink(p);
        }));
    }
}

export function randomName(l: number): string {
    let s = '';
    for (let i = 0; i < l; i++)
        s += String.fromCharCode(97 + Math.random() * 26);
    return s;
}
