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
     * Handle start speech recognition request.
     *
     * @param data Request data from iframe.
     * @param respond Function to respond to iframe.
     */
    async handleStart(data: CoreH5PSpeechRecognitionStartData, respond: CoreH5PRespondFunction): Promise<void> {
        const requestId = data.requestId;

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
        if (this.isListening && this.currentRequestId !== requestId) {
            respond('speech_recognition_response', {
                requestId,
                type: 'error',
                error: 'aborted',
                message: 'Another speech recognition session is already active. Please try again.',
            });

            return;
        }

        try {
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

            // Store the active recognition
            this.activeRecognitions.set(requestId, {
                options: data.options,
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

            // Start listening
            const matches = await CoreSpeechRecognition.startListening({
                language: data.options.language,
                matches: data.options.matches || 5,
                showPartial: data.options.showPartial || false,
                showPopup: false, // Don't show native popup for H5P
            });

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
                requestId,
                type: 'error',
                error: errorType,
                message,
            });
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
            // Even if stop fails, clean up
            this.isListening = false;
            this.currentRequestId = null;
            this.activeRecognitions.delete(requestId);
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
            try {
                await CoreSpeechRecognition.stopListening();
            } catch {
                // Ignore errors on abort
            }

            this.isListening = false;
            this.currentRequestId = null;
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
