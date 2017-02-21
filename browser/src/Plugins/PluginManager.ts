import { EventEmitter } from "events"
import * as fs from "fs"
import * as mkdirp from "mkdirp"
import * as os from "os"
import * as path from "path"
import * as Config from "./../Config"
import { INeovimInstance } from "./../NeovimInstance"
import * as UI from "./../UI/index"


import * as Capabilities from "./Api/Capabilities"
import * as Channel from "./Api/Channel"
import { Plugin } from "./Plugin"
import { CallbackCommand, CommandManager } from "./../Services/CommandManager"

const corePluginsRoot = path.join(__dirname, "vim", "core")
const defaultPluginsRoot = path.join(__dirname, "vim", "default")

export interface IBufferInfo {
    lines: string[]
    version: number
    fileName: string
}

export interface IEventContext {
    bufferFullPath: string
    line: number
    column: number
    byte: number
    filetype: string
}

export class PluginManager extends EventEmitter {
    private _rootPluginPaths: string[] = []
    private _extensionPath: string
    private _plugins: Plugin[] = []
    private _neovimInstance: INeovimInstance
    private _lastEventContext: any
    private _lastBufferInfo: IBufferInfo

    private _channel: Channel.IChannel = new Channel.InProcessChannel()

    constructor(
        private _commandManager: CommandManager,
    ) {
        super()

        this._rootPluginPaths.push(corePluginsRoot)

        if (Config.getValue<boolean>("oni.useDefaultConfig")) {
            this._rootPluginPaths.push(defaultPluginsRoot)
            this._rootPluginPaths.push(path.join(defaultPluginsRoot, "bundle"))
        }

        this._extensionPath = this._ensureOniPluginsPath()
        this._rootPluginPaths.push(this._extensionPath)

        this._rootPluginPaths.push(path.join(Config.getUserFolder(), "plugins"))

        this._channel.host.onResponse((arg: any) => this._handlePluginResponse(arg))
    }

    public get currentBuffer(): IBufferInfo {
        return this._lastBufferInfo
    }

    public gotoDefinition(): void {
        this._sendLanguageServiceRequest("goto-definition", this._lastEventContext)
    }

    public requestFormat(): void {
        this._sendLanguageServiceRequest("format", this._lastEventContext, "formatting")
    }

    public requestEvaluateBlock(id: string, fileName: string, code: string): void {
        this._sendLanguageServiceRequest("evaluate-block", this._lastEventContext, "evaluate-block", {
            id,
            fileName,
            code,
        })
    }

    public notifyCompletionItemSelected(completionItem: any): void {
        this._sendLanguageServiceRequest("completion-provider-item-selected", this._lastEventContext, "completion-provider", { item: completionItem })
    }

    public startPlugins(neovimInstance: INeovimInstance): void {
        this._neovimInstance = neovimInstance

        this._neovimInstance.on("buffer-update", (args: Oni.EventContext, bufferLines: string[]) => {
            this._onBufferUpdate(args, bufferLines)
        })

        this._neovimInstance.on("event", (eventName: string, context: Oni.EventContext) => {
            this._onEvent(eventName, context)
        })

        const allPlugins = this._getAllPluginPaths()
        this._plugins = allPlugins.map((pluginRootDirectory) => this._createPlugin(pluginRootDirectory))
    }

    private _createPlugin(pluginRootDirectory: string): Plugin {
        const plugin = new Plugin(pluginRootDirectory, this._channel)

        plugin.commands.forEach((commandInfo) => {
            this._commandManager.registerCommand(new CallbackCommand(commandInfo.command, commandInfo.name, commandInfo.details, (args?: any) => {
                this._channel.host.send({
                    type: "command",
                    payload: {
                        args,
                        eventContext: this._lastEventContext
                    }
                })
            }))
        })

        return plugin
    }

    public getAllRuntimePaths(): string[] {
        const pluginPaths = this._getAllPluginPaths()

        return pluginPaths.concat(this._rootPluginPaths)
    }

    private _ensureOniPluginsPath(): string {
        const rootOniPluginsDir = path.join(os.homedir(), ".oni", "extensions")

        mkdirp.sync(rootOniPluginsDir)
        return rootOniPluginsDir
    }

    private _getAllPluginPaths(): string[] {
        const paths: string[] = []
        this._rootPluginPaths.forEach((rp) => {
            const subPaths = getDirectories(rp)
            paths.push(...subPaths)
        })

        return paths
    }

    private _handlePluginResponse(pluginResponse: any): void {
        if (pluginResponse.type === "show-quick-info") {
            if (!this._validateOriginEventMatchesCurrentEvent(pluginResponse)) {
                return
            }

            if (!pluginResponse.error) {
                UI.hideQuickInfo()
                setTimeout(() => {
                    if (!this._validateOriginEventMatchesCurrentEvent(pluginResponse)) {
                        return
                    }
                    UI.showQuickInfo(pluginResponse.payload.info, pluginResponse.payload.documentation)
                }, Config.getValue<number>("editor.quickInfo.delay"))
            } else {
                setTimeout(() => UI.hideQuickInfo())
            }
        } else if (pluginResponse.type === "goto-definition") {
            if (!this._validateOriginEventMatchesCurrentEvent(pluginResponse)) {
                return
            }

            // TODO: Refactor to 'Service', break remaining NeoVim dependencies
            const { filePath, line, column } = pluginResponse.payload
            this._neovimInstance.command("e! " + filePath)
            this._neovimInstance.command("keepjumps norm " + line + "G" + column)
            this._neovimInstance.command("norm zz")
        } else if (pluginResponse.type === "completion-provider") {
            if (!this._validateOriginEventMatchesCurrentEvent(pluginResponse)) {
                return
            }

            if (!pluginResponse.payload) {
                return
            }

            setTimeout(() => UI.showCompletions(pluginResponse.payload))
        } else if (pluginResponse.type === "completion-provider-item-selected") {
            setTimeout(() => UI.setDetailedCompletionEntry(pluginResponse.payload.details))
        } else if (pluginResponse.type === "set-errors") {
            this.emit("set-errors", pluginResponse.payload.key, pluginResponse.payload.fileName, pluginResponse.payload.errors, pluginResponse.payload.color)
        } else if (pluginResponse.type === "format") {
            this.emit("format", pluginResponse.payload)
        } else if (pluginResponse.type === "execute-shell-command") {
            // TODO: Check plugin permission
            this.emit("execute-shell-command", pluginResponse.payload)
        } else if (pluginResponse.type === "evaluate-block-result") {
            this.emit("evaluate-block-result", pluginResponse.payload)
        } else if (pluginResponse.type === "set-syntax-highlights") {
            this.emit("set-syntax-highlights", pluginResponse.payload)
        } else if (pluginResponse.type === "clear-syntax-highlights") {
            this.emit("clear-syntax-highlights", pluginResponse.payload)
        } else if (pluginResponse.type === "signature-help-response") {
            this.emit("signature-help-response", pluginResponse.error, pluginResponse.payload)
        }
    }

    private _onBufferUpdate(eventContext: Oni.EventContext, bufferLines: string[]): void {
        this._lastBufferInfo = {
            lines: bufferLines,
            fileName: eventContext.bufferFullPath,
            version: eventContext.version,
        }

        this._channel.host.send({
            type: "buffer-update",
            payload: {
                eventContext,
                bufferLines,
            },
        }, Capabilities.createPluginFilter(eventContext.filetype, { subscriptions: ["buffer-update"] }, false))
    }

    private _onEvent(eventName: string, eventContext: Oni.EventContext): void {
        this._lastEventContext = eventContext

        this._channel.host.send({
            type: "event",
            payload: {
                name: eventName,
                context: eventContext,
            },
        }, Capabilities.createPluginFilter(this._lastEventContext.filetype, { subscriptions: ["vim-events"] }, false))

        if (eventName === "CursorMoved" && Config.getValue<boolean>("editor.quickInfo.enabled")) {
            this._sendLanguageServiceRequest("quick-info", eventContext)

        } else if (eventName === "CursorMovedI" && Config.getValue<boolean>("editor.completions.enabled")) {
            this._sendLanguageServiceRequest("completion-provider", eventContext)

            this._sendLanguageServiceRequest("signature-help", eventContext)
        }
    }

    private _sendLanguageServiceRequest(requestName: string, eventContext: any, languageServiceCapability?: any, additionalArgs?: any): void {
        languageServiceCapability = languageServiceCapability || requestName
        additionalArgs = additionalArgs || {}

        const payload = {
            name: requestName,
            context: eventContext,
            ...additionalArgs,
        }

        this._channel.host.send({
            type: "request",
            payload,
        }, Capabilities.createPluginFilter(eventContext.filetype, { languageService: [languageServiceCapability] }, true))
    }

    /**
     * Validate that the originating event matched the initating event
     */
    private _validateOriginEventMatchesCurrentEvent(pluginResponse: any): boolean {
        const currentEvent = this._lastEventContext
        const originEvent = pluginResponse.meta.originEvent

        if (originEvent.bufferFullPath === currentEvent.bufferFullPath
            && originEvent.line === currentEvent.line
            && originEvent.column === currentEvent.column) {
            return true
        } else {
            console.log("Plugin response aborted as it didn't match current even (buffer/line/col)") // tslint:disable-line no-console
            return false
        }
    }
}

function getDirectories(rootPath: string): string[] {
    if (!fs.existsSync(rootPath)) {
        return []
    }

    return fs.readdirSync(rootPath)
        .map((f) => path.join(rootPath.toString(), f))
        .filter((f) => fs.statSync(f).isDirectory())
}
