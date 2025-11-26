// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable } from '@angular/core';
import { CoreSpeechRecognition } from '@singletons/speech-recognition';
import { CorePlatform } from '@services/platform';

/**
 * Service to handle speech recognition requests from H5P iframes.
 */
@Injectable({ providedIn: 'root' })
export class CoreH5PSpeechRecognitionHandlerService {

    protected activeRecognitions: Map<string, {
        options: CoreH5PSpeechRecognitionOptions;
        respond: CoreH5PRespondFunction;
        aborted: boolean;
    }> = new Map();

    protected isListening = false; // Track if native plugin is currently listening
    protected currentRequestId: string | null = null; // Track which request is using the native plugin
    protected recognitionMutex: Promise<void> = Promise.resolve(); // Mutex for preventing race conditions

    constructor() {
        // Expose this service globally for h5p-resizer.js to access
        if (typeof window !== 'undefined') {
            window.CoreH5PSpeechRecognitionHandler = {
                handleStart: this.handleStart.bind(this),
                handleStop: this.handleStop.bind(this),
                handleAbort: this.handleAbort.bind(this),
            };
        }
    }

    /**
     * Validate and sanitize speech recognition options from iframe.
     *
     * @param options Options to validate.
     * @returns Validated options.
     */
    protected validateSpeechOptions(options: any): CoreH5PSpeechRecognitionOptions {
        // Validate language - must be valid BCP 47 language code
        const languageRegex = /^[a-z]{2,3}(-[A-Z]{2})?$/;
        const language = typeof options.language === 'string' &&
                        languageRegex.test(options.language)
                        ? options.language
                        : 'en-US';

        // Validate matches - must be positive integer between 1-10
        let matches = 5;
        if (typeof options.matches === 'number' &&
            Number.isFinite(options.matches) &&
            options.matches >= 1 &&
            options.matches <= 10) {
            matches = Math.floor(options.matches);
        }

        // Validate booleans
        const showPartial = options.showPartial === true;
        const continuous = options.continuous === true;

        return { language, matches, showPartial, continuous };
    }

    /**
     * Acquire mutex lock for recognition operations.
     *
     * @returns Function to release the lock.
     */
    protected async acquireLock(): Promise<() => void> {
        const previousLock = this.recognitionMutex;
        let releaseLock!: () => void;

        this.recognitionMutex = new Promise(resolve => {
            releaseLock = resolve;
        });

        await previousLock;

        return releaseLock;
    }

    /**
     * Wrap promise with timeout.
     *
     * @param promise Promise to wrap.
     * @param timeoutMs Timeout in milliseconds.
     * @param errorMessage Error message for timeout.
     * @returns Promise that rejects on timeout.
     */
    protected withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;

        const timeoutPromise = new Promise<T>((_, reject) => {
            timeoutId = setTimeout(() => {
                timeoutId = null;
                reject(new Error(errorMessage));
            }, timeoutMs);
        });

        // CRITICAL FIX: Clear timeout on successful completion to prevent memory leak
        return Promise.race([
            promise.then((result) => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }

                return result;
            }).catch((error) => {
                if (timeoutId !== null) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                throw error;
            }),
            timeoutPromise,
        ]);
    }

    /**
     * Handle start speech recognition request.
     *
     * @param data Request data from iframe.
     * @param respond Function to respond to iframe.
     */
    async handleStart(data: CoreH5PSpeechRecognitionStartData, respond: CoreH5PRespondFunction): Promise<void> {
        // FIX: Acquire mutex lock to prevent race conditions
        const release = await this.acquireLock();

        try {
            // Validate request ID
            const requestId = typeof data.requestId === 'string' ? data.requestId : '';
            // SECURITY FIX: Validate request ID format (defense in depth)
            const requestIdRegex = /^speech_\d+_\d+$/;
            if (!requestId || !requestIdRegex.test(requestId)) {
                respond('speech_recognition_response', {
                    requestId: requestId || '',
                    type: 'error',
                    error: 'aborted',
                    message: 'Invalid request ID format. Expected format: speech_<counter>_<timestamp>',
                });

                return;
            }

            if (!CorePlatform.isMobile()) {
                respond('speech_recognition_response', {
                    requestId,
                    type: 'error',
                    error: 'not-allowed',
                    message: 'Speech recognition is only available on mobile devices',
                });

                return;
            }

            // FIX: Prevent concurrent recognition requests
            if (this.isListening) {
                respond('speech_recognition_response', {
                    requestId,
                    type: 'error',
                    error: 'aborted',
                    message: 'Another speech recognition session is already active. Please try again.',
                });

                return;
            }

            // Check if available
            const available = await CoreSpeechRecognition.isAvailable();
            if (!available) {
                respond('speech_recognition_response', {
                    requestId,
                    type: 'error',
                    error: 'not-allowed',
                    message: 'Speech recognition is not available on this device',
                });

                return;
            }

            // FIX: Validate and sanitize all input from iframe
            const validatedOptions = this.validateSpeechOptions(data.options || {});

            // Store the active recognition
            this.activeRecognitions.set(requestId, {
                options: validatedOptions,
                respond,
                aborted: false,
            });

            // Mark as listening before starting
            this.isListening = true;
            this.currentRequestId = requestId;

            // Check if aborted before starting
            const recognitionBeforeStart = this.activeRecognitions.get(requestId);
            if (!recognitionBeforeStart || recognitionBeforeStart.aborted) {
                this.isListening = false;
                this.currentRequestId = null;
                this.activeRecognitions.delete(requestId);

                return;
            }

            // FIX: Start listening with timeout protection
            const matches = await this.withTimeout(
                CoreSpeechRecognition.startListening({
                    language: validatedOptions.language,
                    matches: validatedOptions.matches,
                    showPartial: validatedOptions.showPartial,
                    showPopup: false, // Don't show native popup for H5P
                }),
                30000, // 30 second timeout
                'Speech recognition timed out after 30 seconds',
            );

            // Check if aborted in the meantime
            const recognition = this.activeRecognitions.get(requestId);
            if (!recognition || recognition.aborted) {
                this.isListening = false;
                this.currentRequestId = null;
                this.activeRecognitions.delete(requestId);

                return;
            }

            // Send results
            respond('speech_recognition_response', {
                requestId,
                type: 'result',
                results: matches,
                isFinal: true,
            });

            // If continuous mode and not aborted, keep listening
            if (data.options.continuous && !recognition.aborted) {
                // For continuous mode, we'd need to call startListening again
                // But the current plugin doesn't support true continuous mode
                // So we just mark it as ended
                respond('speech_recognition_response', {
                    requestId,
                    type: 'end',
                });
            } else {
                // End recognition
                respond('speech_recognition_response', {
                    requestId,
                    type: 'end',
                });
            }

            this.isListening = false;
            this.currentRequestId = null;
            this.activeRecognitions.delete(requestId);
        } catch (error) {
            this.isListening = false;
            this.currentRequestId = null;
            this.activeRecognitions.delete(requestId);

            // FIX: Try to stop native plugin on error
            try {
                await CoreSpeechRecognition.stopListening();
            } catch {
                // Ignore errors when stopping
            }

            let errorType = 'network';
            let message = 'Speech recognition failed';

            if (typeof error === 'string') {
                message = error;
                if (error.includes('permission') || error.includes('denied')) {
                    errorType = 'not-allowed';
                } else if (error.includes('audio')) {
                    errorType = 'audio-capture';
                } else if (error.includes('network')) {
                    errorType = 'network';
                } else if (error.includes('match') || error.includes('no-speech')) {
                    errorType = 'no-speech';
                }
            } else if (error instanceof Error) {
                message = error.message;
            }

            respond('speech_recognition_response', {
                requestId: data.requestId || '',
                type: 'error',
                error: errorType,
                message,
            });
        } finally {
            // FIX: Always release the mutex lock
            release();
        }
    }

    /**
     * Handle stop speech recognition request.
     *
     * @param data Request data from iframe.
     * @param respond Function to respond to iframe.
     */
    async handleStop(data: CoreH5PSpeechRecognitionStopData, respond: CoreH5PRespondFunction): Promise<void> {
        const requestId = data.requestId;
        const recognition = this.activeRecognitions.get(requestId);

        if (!recognition) {
            return; // Not found, probably already stopped
        }

        // FIX: Only stop native plugin if this is the current request
        if (this.currentRequestId !== requestId) {
            this.activeRecognitions.delete(requestId);

            return;
        }

        // CRITICAL FIX: Acquire mutex lock to prevent race with handleStart/handleAbort
        const release = await this.acquireLock();

        try {
            await CoreSpeechRecognition.stopListening();

            respond('speech_recognition_response', {
                requestId,
                type: 'end',
            });

            this.isListening = false;
            this.currentRequestId = null;
            this.activeRecognitions.delete(requestId);
        } catch (error) {
            // CRITICAL FIX: Send error response to iframe
            this.logger.error('Error stopping speech recognition:', error);

            respond('speech_recognition_response', {
                requestId,
                type: 'error',
                error: 'aborted',
                message: error instanceof Error ? error.message : 'Failed to stop speech recognition',
            });

            // Even if stop fails, clean up
            this.isListening = false;
            this.currentRequestId = null;
            this.activeRecognitions.delete(requestId);
        } finally {
            release();
        }
    }

    /**
     * Handle abort speech recognition request.
     *
     * @param data Request data from iframe.
     * @param respond Function to respond to iframe.
     */
    async handleAbort(data: CoreH5PSpeechRecognitionAbortData, respond: CoreH5PRespondFunction): Promise<void> {
        const requestId = data.requestId;
        const recognition = this.activeRecognitions.get(requestId);

        if (recognition) {
            recognition.aborted = true;
        }

        // FIX: Only stop native plugin if this is the current request
        if (this.currentRequestId === requestId) {
            // CRITICAL FIX: Acquire mutex lock to prevent race with handleStart/handleStop
            const release = await this.acquireLock();

            try {
                await CoreSpeechRecognition.stopListening();

                this.isListening = false;
                this.currentRequestId = null;
            } catch (error) {
                // Ignore errors on abort but log them
                this.logger.warn('Error aborting speech recognition:', error);

                this.isListening = false;
                this.currentRequestId = null;
            } finally {
                release();
            }
        }

        this.activeRecognitions.delete(requestId);

        // FIX: Send abort confirmation response
        respond('speech_recognition_response', {
            requestId,
            type: 'end',
        });
    }

}

/**
 * Request data for starting speech recognition.
 */
export type CoreH5PSpeechRecognitionStartData = {
    requestId: string;
    options: CoreH5PSpeechRecognitionOptions;
};

/**
 * Options for speech recognition.
 */
export type CoreH5PSpeechRecognitionOptions = {
    language: string;
    matches: number;
    showPartial: boolean;
    continuous: boolean;
};

/**
 * Request data for stopping speech recognition.
 */
export type CoreH5PSpeechRecognitionStopData = {
    requestId: string;
};

/**
 * Request data for aborting speech recognition.
 */
export type CoreH5PSpeechRecognitionAbortData = {
    requestId: string;
};

/**
 * Response function type.
 */
export type CoreH5PRespondFunction = (action: string, data: unknown) => void;

/**
 * Extend the Window interface to include the speech recognition handler.
 */
declare global {
    interface Window {
        CoreH5PSpeechRecognitionHandler?: {
            handleStart: (data: CoreH5PSpeechRecognitionStartData, respond: CoreH5PRespondFunction) => Promise<void>;
            handleStop: (data: CoreH5PSpeechRecognitionStopData, respond: CoreH5PRespondFunction) => Promise<void>;
            handleAbort: (data: CoreH5PSpeechRecognitionAbortData, respond: CoreH5PRespondFunction) => Promise<void>;
        };
    }
}
