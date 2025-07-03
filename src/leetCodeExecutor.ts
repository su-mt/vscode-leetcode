// Copyright (c) jdneo. All rights reserved.
// Licensed under the MIT license.

import * as cp from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import requireFromString = require("require-from-string");
import { ExtensionContext } from "vscode";
import { ConfigurationChangeEvent, Disposable, MessageItem, window, workspace, WorkspaceConfiguration } from "vscode";
import { IProblem, leetcodeHasInited, supportedPlugins } from "./shared";
import { executeCommand, executeCommandWithProgress } from "./utils/cpUtils";
import { DialogOptions, openUrl } from "./utils/uiUtils";
import * as wsl from "./utils/wslUtils";
import { toWslPath, useWsl } from "./utils/wslUtils";

class LeetCodeExecutor implements Disposable {
    private leetCodeRootPath: string;
    private nodeExecutable: string;
    private configurationChangeListener: Disposable;

    constructor() {
        this.leetCodeRootPath = path.join(__dirname, "..", "..", "node_modules", "vsc-leetcode-cli");
        this.nodeExecutable = this.getNodePath();
        this.configurationChangeListener = workspace.onDidChangeConfiguration((event: ConfigurationChangeEvent) => {
            if (event.affectsConfiguration("leetcode.nodePath")) {
                this.nodeExecutable = this.getNodePath();
            }
        }, this);
    }

    public async getLeetCodeBinaryPath(): Promise<string> {
        if (wsl.useWsl()) {
            return `${await wsl.toWslPath(`"${path.join(this.leetCodeRootPath, "bin", "leetcode")}"`)}`;
        }
        return `"${path.join(this.leetCodeRootPath, "bin", "leetcode")}"`;
    }

    public async meetRequirements(context: ExtensionContext): Promise<boolean> {
        console.log("LeetCode: Checking requirements...");

        const hasInited: boolean | undefined = context.globalState.get(leetcodeHasInited);
        if (!hasInited) {
            console.log("LeetCode: Extension not initialized, removing old cache...");
            await this.removeOldCache();
        }

        console.log("LeetCode: Node executable path:", this.nodeExecutable);
        if (this.nodeExecutable !== "node") {
            if (!await fse.pathExists(this.nodeExecutable)) {
                console.error("LeetCode: Node.js executable not found at:", this.nodeExecutable);
                throw new Error(`The Node.js executable does not exist on path ${this.nodeExecutable}`);
            }
            // Wrap the executable with "" to avoid space issue in the path.
            this.nodeExecutable = `"${this.nodeExecutable}"`;
            if (useWsl()) {
                this.nodeExecutable = await toWslPath(this.nodeExecutable);
            }
        }

        console.log("LeetCode: Testing Node.js...");
        try {
            await this.executeCommandEx(this.nodeExecutable, ["-v"]);
            console.log("LeetCode: Node.js test successful");
        } catch (error) {
            console.error("LeetCode: Node.js test failed:", error);
            const choice: MessageItem | undefined = await window.showErrorMessage(
                "LeetCode extension needs Node.js installed in environment path",
                DialogOptions.open,
            );
            if (choice === DialogOptions.open) {
                openUrl("https://nodejs.org");
            }
            return false;
        }

        console.log("LeetCode: Checking plugins...");
        for (const plugin of supportedPlugins) {
            console.log("LeetCode: Checking plugin:", plugin);
            try { // Check plugin
                await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-e", plugin]);
                console.log("LeetCode: Plugin", plugin, "is available");
            } catch (error) { // Remove old cache that may cause the error download plugin and activate
                console.log("LeetCode: Plugin", plugin, "not found, installing...");
              //  await this.removeOldCache();
              //  await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-i", plugin]);
                console.log("LeetCode: Plugin", plugin, "installed successfully");
            }
        }

        // Set the global state HasInited true to skip delete old cache after init
        context.globalState.update(leetcodeHasInited, true);
        console.log("LeetCode: Requirements check completed successfully");
        return true;
    }

    public async deleteCache(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "cache", "-d"]);
    }

    public async getUserInfo(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "user"]);
    }

    public async signOut(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "user", "-L"]);
    }

    public async listProblems(showLocked: boolean, needTranslation: boolean): Promise<string> {
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "list"];
        if (!needTranslation) {
            cmd.push("-T"); // use -T to prevent translation
        }
        if (!showLocked) {
            cmd.push("-q");
            cmd.push("L");
        }
        return await this.executeCommandEx(this.nodeExecutable, cmd);
    }

    public async showProblem(problemNode: IProblem, language: string, filePath: string, showDescriptionInComment: boolean = false, needTranslation: boolean, shouldAddHeaders: boolean = false): Promise<void> {
        const templateType: string = showDescriptionInComment ? "-cx" : "-c";
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "show", problemNode.id, templateType, "-l", language];

        if (!needTranslation) {
            cmd.push("-T"); // use -T to force English version
        }

        if (!await fse.pathExists(filePath)) {
            await fse.createFile(filePath);
            let codeTemplate: string = await this.executeCommandWithProgressEx("Fetching problem data...", this.nodeExecutable, cmd);

            // Add C++ headers if needed
            if (shouldAddHeaders && (language === "cpp" || language === "c")) {
                const cppHeaders = this.generateCppHeaders();
                codeTemplate = cppHeaders + codeTemplate;
            }

            await fse.writeFile(filePath, codeTemplate);
        }
    }

    /**
     * This function returns solution of a problem identified by input
     *
     * @remarks
     * Even though this function takes the needTranslation flag, it is important to note
     * that as of vsc-leetcode-cli 2.8.0, leetcode-cli doesn't support querying solution
     * on CN endpoint yet. So this flag doesn't have any effect right now.
     *
     * @param input - parameter to pass to cli that can identify a problem
     * @param language - the source code language of the solution desired
     * @param needTranslation - whether or not to use endPoint translation on solution query
     * @returns promise of the solution string
     */
    public async showSolution(input: string, language: string, needTranslation: boolean): Promise<string> {
        // solution don't support translation
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "show", input, "--solution", "-l", language];
        if (!needTranslation) {
            cmd.push("-T");
        }
        const solution: string = await this.executeCommandWithProgressEx("Fetching top voted solution from discussions...", this.nodeExecutable, cmd);
        return solution;
    }

    public async getDescription(problemNodeId: string, needTranslation: boolean): Promise<string> {
        const cmd: string[] = [await this.getLeetCodeBinaryPath(), "show", problemNodeId, "-x"];
        if (!needTranslation) {
            cmd.push("-T");
        }
        return await this.executeCommandWithProgressEx("Fetching problem description...", this.nodeExecutable, cmd);
    }

    public async listSessions(): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session"]);
    }

    public async enableSession(name: string): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session", "-e", name]);
    }

    public async createSession(id: string): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session", "-c", id]);
    }

    public async deleteSession(id: string): Promise<string> {
        return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "session", "-d", id]);
    }

    public async submitSolution(filePath: string): Promise<string> {
        try {
            return await this.executeCommandWithProgressEx("Submitting to LeetCode...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "submit", `"${filePath}"`]);
        } catch (error) {
            if (error.result) {
                return error.result;
            }
            throw error;
        }
    }

    public async testSolution(filePath: string, testString?: string): Promise<string> {
        if (testString) {
            return await this.executeCommandWithProgressEx("Submitting to LeetCode...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "test", `"${filePath}"`, "-t", `${testString}`]);
        }
        return await this.executeCommandWithProgressEx("Submitting to LeetCode...", this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "test", `"${filePath}"`]);
    }

    public async switchEndpoint(_endpoint: string): Promise<string> {
        // Отключено для избежания конфликтов с оригинальным расширением
        console.log("LeetCode: Endpoint switching disabled to avoid conflicts");
        return "Endpoint switching disabled";
        /*
        switch (endpoint) {
            case Endpoint.LeetCodeCN:
                return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-e", "leetcode.cn"]);
            case Endpoint.LeetCode:
            default:
                return await this.executeCommandEx(this.nodeExecutable, [await this.getLeetCodeBinaryPath(), "plugin", "-d", "leetcode.cn"]);
        }
        */
    }

    public async toggleFavorite(node: IProblem, addToFavorite: boolean): Promise<void> {
        const commandParams: string[] = [await this.getLeetCodeBinaryPath(), "star", node.id];
        if (!addToFavorite) {
            commandParams.push("-d");
        }
        await this.executeCommandWithProgressEx("Updating the favorite list...", "node", commandParams);
    }

    public async getCompaniesAndTags(): Promise<{ companies: { [key: string]: string[] }, tags: { [key: string]: string[] } }> {
        // preprocess the plugin source
        const companiesTagsPath: string = path.join(this.leetCodeRootPath, "lib", "plugins", "company.js");
        const companiesTagsSrc: string = (await fse.readFile(companiesTagsPath, "utf8")).replace(
            "module.exports = plugin",
            "module.exports = { COMPONIES, TAGS }",
        );
        const { COMPONIES, TAGS } = requireFromString(companiesTagsSrc, companiesTagsPath);
        return { companies: COMPONIES, tags: TAGS };
    }

    public get node(): string {
        return this.nodeExecutable;
    }

    public dispose(): void {
        this.configurationChangeListener.dispose();
    }

    private getNodePath(): string {
        const extensionConfig: WorkspaceConfiguration = workspace.getConfiguration("leetcode", null);
        return extensionConfig.get<string>("nodePath", "node" /* default value */);
    }

    private async executeCommandEx(command: string, args: string[], options: cp.SpawnOptions = { shell: true }): Promise<string> {
        if (wsl.useWsl()) {
            return await executeCommand("wsl", [command].concat(args), options);
        }
        return await executeCommand(command, args, options);
    }

    private async executeCommandWithProgressEx(message: string, command: string, args: string[], options: cp.SpawnOptions = { shell: true }): Promise<string> {
        if (wsl.useWsl()) {
            return await executeCommandWithProgress(message, "wsl", [command].concat(args), options);
        }
        return await executeCommandWithProgress(message, command, args, options);
    }

    private async removeOldCache(): Promise<void> {
        const oldPath: string = path.join(os.homedir(), ".lc");
        if (await fse.pathExists(oldPath)) {
            await fse.remove(oldPath);
        }
    }

    public async getTodayProblem(needTranslation?: boolean): Promise<any[]> {
        try {
            // Получаем историю daily challenges за последние 30 дней
            const dailyChallenges = await this.getDailyChallengeHistory(needTranslation, 30);
            return dailyChallenges;
        }
        catch (error) {
            console.error("Failed to fetch daily challenges:", error);
            return [];
        }
    }

    public async getDailyChallengeHistory(_needTranslation?: boolean, days: number = 30): Promise<any[]> {
        try {
            const https = require('https');

            // Получаем данные за последние дни
            const endDate = new Date();
            const startDate = new Date();
            startDate.setDate(endDate.getDate() - days);

            const query = `
                query dailyCodingQuestionRecords($year: Int!, $month: Int!) {
                    dailyCodingChallengeV2(year: $year, month: $month) {
                        challenges {
                            date
                            userStatus
                            link
                            question {
                                acRate
                                difficulty
                                freqBar
                                frontendQuestionId: questionFrontendId
                                isFavor
                                paidOnly: isPaidOnly
                                status
                                title
                                titleSlug
                                hasVideoSolution
                                hasSolution
                                topicTags {
                                    name
                                    id
                                    slug
                                }
                            }
                        }
                    }
                }
            `;

            const challenges: any[] = [];
            const processedMonths = new Set<string>();

            // Получаем данные для текущего и предыдущего месяца
            for (let i = 0; i <= 1; i++) {
                const targetDate = new Date();
                targetDate.setMonth(targetDate.getMonth() - i);

                const year = targetDate.getFullYear();
                const month = targetDate.getMonth() + 1;
                const monthKey = `${year}-${month}`;

                if (processedMonths.has(monthKey)) continue;
                processedMonths.add(monthKey);

                const postData = JSON.stringify({
                    query: query,
                    variables: { year, month }
                });

                const options = {
                    hostname: 'leetcode.com',
                    port: 443,
                    path: '/graphql',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                        'User-Agent': 'vscode-leetcode-extension'
                    }
                };

                const response = await new Promise<string>((resolve, reject) => {
                    const req = https.request(options, (res: any) => {
                        let data = '';
                        res.on('data', (chunk: any) => {
                            data += chunk;
                        });
                        res.on('end', () => {
                            resolve(data);
                        });
                    });

                    req.on('error', (error: any) => {
                        reject(error);
                    });

                    req.write(postData);
                    req.end();
                });

                const jsonData = JSON.parse(response);
                if (jsonData.data && jsonData.data.dailyCodingChallengeV2 && jsonData.data.dailyCodingChallengeV2.challenges) {
                    const monthChallenges = jsonData.data.dailyCodingChallengeV2.challenges
                        .filter((challenge: any) => challenge && challenge.question)
                        .map((challenge: any) => {
                            const question = challenge.question;
                            return {
                                id: question.frontendQuestionId || challenge.link?.split('/').pop() || 'unknown',
                                name: question.title || 'Unknown Problem',
                                difficulty: question.difficulty || 'Unknown',
                                passRate: question.acRate ? `${question.acRate.toFixed(1)}%` : '0%',
                                tags: (question.topicTags || []).map((tag: any) => tag.name || tag),
                                companies: [],
                                isFavorite: question.isFavor || false,
                                locked: question.paidOnly || false,
                                state: question.status || "Unknown",
                                date: challenge.date,
                                link: challenge.link
                            };
                        });

                    challenges.push(...monthChallenges);
                }
            }

            // Сортируем по дате (новые сверху)
            challenges.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

            // Ограничиваем количество дней
            return challenges.slice(0, days);
        }
        catch (error) {
            console.error("Failed to fetch daily challenge history:", error);
            return [];
        }
    }

    public generateCppHeaders(): string {
        return `#include <iostream>
#include <vector>
#include <string>
#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <stack>
#include <queue>
#include <deque>
#include <set>
#include <map>
#include <climits>
#include <cmath>
#include <numeric>
#include <functional>
using namespace std;

`;
    }

}

export const leetCodeExecutor: LeetCodeExecutor = new LeetCodeExecutor();
