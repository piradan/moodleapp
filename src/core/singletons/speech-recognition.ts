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

import { CorePlatform } from '@services/platform';

/**
 * Singleton with helper functions for speech recognition.
 */
export class CoreSpeechRecognition {

    // Avoid creating singleton instances.
    private constructor() {
        // Nothing to do.
    }

    /**
     * Check if speech recognition is available.
     *
     * @returns Promise that resolves with boolean indicating availability.
     */
    static async isAvailable(): Promise<boolean> {
        if (!CorePlatform.isMobile() || !window.plugins?.speechRecognition) {
            return false;
        }

        return new Promise<boolean>((resolve) => {
            window.plugins!.speechRecognition!.isRecognitionAvailable(
                (available: boolean) => resolve(available),
                () => resolve(false),
            );
        });
    }

    /**
     * Check if the app has permission to use speech recognition.
     *
     * @returns Promise that resolves with boolean indicating if permission is granted.
     */
    static async hasPermission(): Promise<boolean> {
        if (!CorePlatform.isMobile() || !window.plugins?.speechRecognition) {
            return false;
        }

        return new Promise<boolean>((resolve) => {
            window.plugins!.speechRecognition!.hasPermission(
                (hasPermission: boolean) => resolve(hasPermission),
                () => resolve(false),
            );
        });
    }

    /**
     * Request permission to use speech recognition.
     *
     * @returns Promise that resolves when permission is granted, rejects otherwise.
     */
    static async requestPermission(): Promise<void> {
        if (!CorePlatform.isMobile() || !window.plugins?.speechRecognition) {
            throw new Error('Speech recognition not available');
        }

        return new Promise<void>((resolve, reject) => {
            window.plugins!.speechRecognition!.requestPermission(
                () => resolve(),
                (error: string) => reject(error),
            );
        });
    }

    /**
     * Start listening for speech.
     *
     * @param options Recognition options.
     * @returns Promise that resolves with array of recognized strings.
     */
    static async startListening(options: CoreSpeechRecognitionOptions): Promise<string[]> {
        if (!CorePlatform.isMobile() || !window.plugins?.speechRecognition) {
            throw new Error('Speech recognition not available');
        }

        // Ensure we have permission first
        const hasPermission = await this.hasPermission();
        if (!hasPermission) {
            await this.requestPermission();
        }

        return new Promise<string[]>((resolve, reject) => {
            window.plugins!.speechRecognition!.startListening(
                (matches: string[]) => resolve(matches),
                (error: string) => reject(error),
                {
                    language: options.language || 'en-US',
                    matches: options.matches || 5,
                    showPopup: options.showPopup !== undefined ? options.showPopup : false,
                    showPartial: options.showPartial || false,
                    prompt: options.prompt || '',
                },
            );
        });
    }

    /**
     * Stop listening for speech (iOS only).
     *
     * @returns Promise that resolves when stopped.
     */
    static async stopListening(): Promise<void> {
        if (!CorePlatform.isMobile() || !window.plugins?.speechRecognition) {
            return;
        }

        return new Promise<void>((resolve, reject) => {
            window.plugins!.speechRecognition!.stopListening(
                () => resolve(),
                (error: string) => reject(error),
            );
        });
    }

    /**
     * Get list of supported languages.
     *
     * @returns Promise that resolves with array of language codes.
     */
    static async getSupportedLanguages(): Promise<string[]> {
        if (!CorePlatform.isMobile() || !window.plugins?.speechRecognition) {
            return [];
        }

        return new Promise<string[]>((resolve) => {
            window.plugins!.speechRecognition!.getSupportedLanguages(
                (languages: string[]) => resolve(languages),
                () => resolve([]),
            );
        });
    }

}

/**
 * Options for speech recognition.
 */
export type CoreSpeechRecognitionOptions = {
    language?: string; // Language code (e.g., 'en-US')
    matches?: number; // Number of matches to return
    showPopup?: boolean; // Show native popup (Android only)
    showPartial?: boolean; // Return partial results
    prompt?: string; // Prompt text (Android only)
};

/**
 * Extend the Window interface to include the speech recognition plugin.
 */
declare global {
    interface Window {
        plugins?: {
            speechRecognition?: {
                isRecognitionAvailable: (
                    success: (available: boolean) => void,
                    error: (error: string) => void,
                ) => void;
                hasPermission: (
                    success: (hasPermission: boolean) => void,
                    error: (error: string) => void,
                ) => void;
                requestPermission: (
                    success: () => void,
                    error: (error: string) => void,
                ) => void;
                startListening: (
                    success: (matches: string[]) => void,
                    error: (error: string) => void,
                    options: {
                        language?: string;
                        matches?: number;
                        showPopup?: boolean;
                        showPartial?: boolean;
                        prompt?: string;
                    },
                ) => void;
                stopListening: (
                    success: () => void,
                    error: (error: string) => void,
                ) => void;
                getSupportedLanguages: (
                    success: (languages: string[]) => void,
                    error: (error: string) => void,
                ) => void;
            };
        };
    }
}
