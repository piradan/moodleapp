// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

/**
 * Web Speech API Polyfill for H5P iframes in Moodle Mobile App
 * This polyfill bridges the Web Speech API to native speech recognition via postMessage
 *
 * @module     core_h5p
 * @copyright  2025 Moodle Pty Ltd.
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

(function(window) {
    'use strict';

    // Check if we're in an iframe and if SpeechRecognition is already available
    if (window.webkitSpeechRecognition || window.SpeechRecognition) {
        // Native implementation available, don't override
        return;
    }

    var requestCounter = 0;

    /**
     * SpeechRecognition polyfill implementation
     * @constructor
     */
    function SpeechRecognitionPolyfill() {
        var self = this;

        // Properties as per Web Speech API spec
        this.continuous = false;
        this.interimResults = false;
        this.lang = 'en-US';
        this.maxAlternatives = 1;

        // Event handlers
        this.onaudiostart = null;
        this.onaudioend = null;
        this.onend = null;
        this.onerror = null;
        this.onnomatch = null;
        this.onresult = null;
        this.onsoundstart = null;
        this.onsoundend = null;
        this.onspeechstart = null;
        this.onspeechend = null;
        this.onstart = null;

        // Internal state
        this._started = false;
        this._requestId = null;
        this._aborted = false;

        // Listen for messages from parent window
        window.addEventListener('message', function(event) {
            if (event.data.context !== 'h5p' || event.data.action !== 'speech_recognition_response') {
                return;
            }

            if (event.data.requestId !== self._requestId) {
                return; // Not for this instance
            }

            self._handleResponse(event.data);
        });
    }

    /**
     * Start speech recognition
     */
    SpeechRecognitionPolyfill.prototype.start = function() {
        var self = this;

        if (this._started) {
            this._fireError('failed', 'recognition has already started');
            return;
        }

        this._started = true;
        this._aborted = false;
        this._requestId = 'speech_' + (++requestCounter) + '_' + Date.now();

        // Fire start event
        setTimeout(function() {
            if (self._aborted) return;
            self._fireEvent('start');
            self._fireEvent('audiostart');
            self._fireEvent('soundstart');
            self._fireEvent('speechstart');
        }, 100);

        // Request permission and start recognition via parent window
        window.parent.postMessage({
            context: 'h5p',
            action: 'speech_recognition_start',
            requestId: this._requestId,
            options: {
                language: this.lang,
                matches: this.maxAlternatives,
                showPartial: this.interimResults,
                continuous: this.continuous
            }
        }, '*');
    };

    /**
     * Stop speech recognition
     */
    SpeechRecognitionPolyfill.prototype.stop = function() {
        if (!this._started) {
            return;
        }

        window.parent.postMessage({
            context: 'h5p',
            action: 'speech_recognition_stop',
            requestId: this._requestId
        }, '*');
    };

    /**
     * Abort speech recognition
     */
    SpeechRecognitionPolyfill.prototype.abort = function() {
        this._aborted = true;

        if (!this._started) {
            return;
        }

        window.parent.postMessage({
            context: 'h5p',
            action: 'speech_recognition_abort',
            requestId: this._requestId
        }, '*');

        this._cleanup();
    };

    /**
     * Handle response from parent window
     * @param {Object} data Response data
     */
    SpeechRecognitionPolyfill.prototype._handleResponse = function(data) {
        var self = this;

        if (data.type === 'result') {
            // Fire result event
            var results = this._createSpeechRecognitionResultList(data.results, data.isFinal);
            var event = this._createEvent('result');
            event.results = results;
            event.resultIndex = 0;

            if (this.onresult) {
                this.onresult(event);
            }

            // If final result and not continuous, end recognition
            if (data.isFinal && !this.continuous) {
                setTimeout(function() {
                    self._fireEvent('speechend');
                    self._fireEvent('soundend');
                    self._fireEvent('audioend');
                    self._fireEnd();
                }, 100);
            }
        } else if (data.type === 'error') {
            this._fireError(data.error, data.message);
            this._cleanup();
        } else if (data.type === 'end') {
            this._fireEvent('speechend');
            this._fireEvent('soundend');
            this._fireEvent('audioend');
            this._fireEnd();
        } else if (data.type === 'nomatch') {
            this._fireEvent('nomatch');
            this._fireEvent('speechend');
            this._fireEvent('soundend');
            this._fireEvent('audioend');
            this._fireEnd();
        }
    };

    /**
     * Create a SpeechRecognitionResultList
     * @param {Array} results Array of recognition results
     * @param {Boolean} isFinal Whether this is the final result
     * @returns {Array} SpeechRecognitionResultList-like array
     */
    SpeechRecognitionPolyfill.prototype._createSpeechRecognitionResultList = function(results, isFinal) {
        var resultList = [];

        if (!results || results.length === 0) {
            return resultList;
        }

        // Create a SpeechRecognitionResult
        var result = [];
        result.isFinal = !!isFinal;

        // Create SpeechRecognitionAlternative objects
        for (var i = 0; i < results.length; i++) {
            result.push({
                transcript: results[i],
                confidence: i === 0 ? 0.9 : 0.7 / (i + 1) // First result gets highest confidence
            });
        }

        // Make it array-like
        result.length = results.length;
        resultList.push(result);
        resultList.length = 1;

        return resultList;
    };

    /**
     * Fire an event
     * @param {String} type Event type
     */
    SpeechRecognitionPolyfill.prototype._fireEvent = function(type) {
        var handler = this['on' + type];
        if (handler) {
            handler(this._createEvent(type));
        }
    };

    /**
     * Fire end event
     */
    SpeechRecognitionPolyfill.prototype._fireEnd = function() {
        if (this.onend) {
            this.onend(this._createEvent('end'));
        }
        this._cleanup();
    };

    /**
     * Fire error event
     * @param {String} error Error type
     * @param {String} message Error message
     */
    SpeechRecognitionPolyfill.prototype._fireError = function(error, message) {
        if (this.onerror) {
            var event = this._createEvent('error');
            event.error = error;
            event.message = message;
            this.onerror(event);
        }
    };

    /**
     * Create an event object
     * @param {String} type Event type
     * @returns {Object} Event object
     */
    SpeechRecognitionPolyfill.prototype._createEvent = function(type) {
        return {
            type: type,
            timeStamp: Date.now()
        };
    };

    /**
     * Cleanup after recognition ends
     */
    SpeechRecognitionPolyfill.prototype._cleanup = function() {
        this._started = false;
        this._requestId = null;
    };

    // Expose the polyfill
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
        window.SpeechRecognition = SpeechRecognitionPolyfill;
        window.webkitSpeechRecognition = SpeechRecognitionPolyfill;

        console.log('[H5P Speech Recognition] Polyfill installed');
    }

})(typeof window !== 'undefined' ? window : global);
