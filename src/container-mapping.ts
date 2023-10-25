import { CommandType, Constants, getEncodedContent, writeToOutStream } from "./msdo-helpers";
import { IMicrosoftSecurityDevOps } from "./msdo-interface";
import * as https from "https";
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as os from 'os';

const sendReportRetryCount: number = 1;

/**
 * Represents the tasks for container mapping that are used to fetch Docker images pushed in a job run.
 */
export class ContainerMapping implements IMicrosoftSecurityDevOps {
    readonly succeedOnError: boolean;

    constructor() {
        this.succeedOnError = true;
    }

    /**
     * Container mapping pre-job commands wrapped in exception handling.
     */
    public runPreJob() {
        try {
            writeToOutStream("::group::Microsoft Defender for DevOps container mapping pre-job - https://go.microsoft.com/fwlink/?linkid=2231419");
            this._runPreJob();
        }
        catch (error) {
            // Log the error
            writeToOutStream("Error in Container Mapping pre-job: " + error);
        }
        finally {
            // End the collapsible section
            writeToOutStream("::endgroup::");
        }
    }


    /*
    * Set the start time of the job run.
    */
    private _runPreJob() {
        const startTime = new Date().toISOString();
        core.saveState('PreJobStartTime', startTime);
        console.log('PreJobStartTime', startTime);
    }

    /**
     * Placeholder / interface satisfier for main operations
     */
    public async runMain() {
        // No commands
    }

    /**
     * Container mapping post-job commands wrapped in exception handling.
     */
    public async runPostJob() {
        try {
            writeToOutStream("::group::Microsoft Defender for DevOps container mapping post-job - https://go.microsoft.com/fwlink/?linkid=2231419");
            await this._runPostJob();
        } catch (error) {
            // Log the error
            writeToOutStream("Error in Container Mapping post-job: " + error);
        } finally {
            // End the collapsible section
            writeToOutStream("::endgroup::");
        }
    }

    /*
    * Using the start time, fetch the docker events and docker images in this job run and log the encoded output
    * Send the report to Defender for DevOps
    */
    private async _runPostJob() {
        let startTime = core.getState('PreJobStartTime');
        if (startTime.length <= 0) {
            startTime = new Date(new Date().getTime() - 10000).toISOString();
            console.log(`PreJobStartTime not defined, using now-10secs`);
        }
        console.log(`PreJobStartTime: ${startTime}`);

        let dockerVersion = [];
        let reportData = {
            dockerVersion: "",
            dockerEvents: [],
            dockerImages: []
        };

        // Initialize the commands 
        await this.execCommand('docker --version', dockerVersion)
        .catch((error) => {
            throw new Error("Unable to get docker version: " + error);
        });
        // The backend expects the docker version to be a string, not an array
        reportData.dockerVersion = dockerVersion.join('');

        await this.execCommand(`docker events --since ${startTime} --until ${new Date().toISOString()} --filter event=push --filter type=image --format ID={{.ID}}`, reportData.dockerEvents)
        .catch((error) => {
            throw new Error("Unable to get docker events: " + error);
        });

        await this.execCommand(`docker images --format CreatedAt={{.CreatedAt}}::Repo={{.Repository}}::Tag={{.Tag}}::Digest={{.Digest}}`, reportData.dockerImages)
        .catch((error) => {
            throw new Error("Unable to get docker images: " + error);
        });

        core.debug("Finished data collection, starting API calls.");

        let bearerToken: string | void = await core.getIDToken()
            .then((token) => { return token; })
            .catch((error) => {
                throw new Error("Unable to get token: " + error);
            });

        if (!bearerToken) {
            throw new Error("Empty OIDC token received");
        }

        var reportSent: boolean = await this.sendReport(JSON.stringify(reportData), bearerToken, sendReportRetryCount);
        if (!reportSent) {
            throw new Error("Unable to send report to backend service");
        };
    }

    /**
     * Execute command and setup the listener to capture the output
     * @param command Command to execute
     * @param listener Listener to capture the output
     * @returns a Promise
     */
    private async execCommand(command: string, listener: string[]): Promise<void> {
        return exec.exec(command, null, {
            listeners: {
                stdout: (data: Buffer) => {
                    var lines = data.toString().trim().split(os.EOL);
                    lines.forEach(element => {
                        listener.push(element);
                    });
                }
            }
        })
        .then((exitCode) => {
            if (exitCode != 0) {
                Promise.reject(`Command failed with exit code ${exitCode}`);
            }
        });
    }

    /**
     * Sends a report to Defender for DevOps and retries on the specified count
     * @param data the data to send
     * @param retryCount the number of time to retry
     * @returns a boolean Promise to indicate if the report was sent successfully or not
     */
    private async sendReport(data: string, bearerToken: string, retryCount: number = 0): Promise<boolean> {
        core.debug(`attempting to send report: ${data}`);
        return await this._sendReport(data, bearerToken)
            .then(() => {
                return true;
            })
            .catch(async (error) => {
                if (retryCount == 0) {
                    return false;
                } else {
                    writeToOutStream(`Retrying API call due to error: ${error}.\nRetry count: ${retryCount}`);
                    retryCount--;
                    return await this.sendReport(data, bearerToken, retryCount);
                }
            });
    }

    /**
     * Sends a report to Defender for DevOps
     * @param data the data to send
     * @returns a Promise
     */
    private async _sendReport(data: string, bearerToken: string): Promise<void> {
        return new Promise(async (resolve, reject) => {
            let apiTime = new Date().getMilliseconds();
            let url: string = "https://dfdinfra-afdendpoint-prod-d5fqbucbg7fue0cf.z01.azurefd.net/github/v1/container-mappings";
            if (process.env.MSDO_DOGFOOD) {
                url = "https://dfdinfra-afdendpoint-dogfood-dqgpa4gjagh0arcw.z01.azurefd.net/github/v1/container-mappings";
            }
            let options = {
                method: 'POST',
                timeout: 2500,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + bearerToken,
                    'Content-Length': data.length
                }
            };
            core.debug(`${options['method'].toUpperCase()} ${url}`);

            const req = https.request(url, options, (res) => {
                let resData = '';
                res.on('data', (chunk) => {
                    resData += chunk.toString();
                });

                res.on('end', () => {
                    core.debug('API calls finished. Time taken: ' + (new Date().getMilliseconds() - apiTime) + "ms");
                    core.debug(`Status code: ${res.statusCode} ${res.statusMessage}`);
                    core.debug('Response headers: ' + JSON.stringify(res.headers));
                    if (resData.length > 0) {
                        core.debug('Response: ' + resData);
                    }
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(`Received Failed Status code when calling url: ${res.statusCode} ${resData}`);
                    }
                    resolve();
                });
            });

            req.on('error', (error) => {
                reject(new Error(`Error calling url: ${error}`));
            });

            req.write(data);
            req.end();
        });
    }
}