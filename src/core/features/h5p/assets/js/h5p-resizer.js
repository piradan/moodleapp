// H5P iframe Resizer
(function () {
  if (!window.postMessage || !window.addEventListener || window.h5pResizerInitialized) {
    return; // Not supported
  }
  window.h5pResizerInitialized = true;

  // Map actions to handlers
  var actionHandlers = {};

  /**
   * Prepare iframe resize.
   *
   * @private
   * @param {Object} iframe Element
   * @param {Object} data Payload
   * @param {Function} respond Send a response to the iframe
   */
  actionHandlers.hello = function (iframe, data, respond) {
    // Make iframe responsive
    iframe.style.width = '100%';

    // Bugfix for Chrome: Force update of iframe width. If this is not done the
    // document size may not be updated before the content resizes.
    iframe.getBoundingClientRect();

    // Tell iframe that it needs to resize when our window resizes
    var resize = function () {
      if (iframe.contentWindow) {
        // Limit resize calls to avoid flickering
        respond('resize');
      }
      else {
        // Frame is gone, unregister.
        window.removeEventListener('resize', resize);
      }
    };
    window.addEventListener('resize', resize, false);

    // Respond to let the iframe know we can resize it
    respond('hello');
  };

  /**
   * Prepare iframe resize.
   *
   * @private
   * @param {Object} iframe Element
   * @param {Object} data Payload
   * @param {Function} respond Send a response to the iframe
   */
  actionHandlers.prepareResize = function (iframe, data, respond) {
    // Do not resize unless page and scrolling differs
    if (iframe.clientHeight !== data.scrollHeight ||
        data.scrollHeight !== data.clientHeight) {

      // Reset iframe height, in case content has shrinked.
      iframe.style.height = data.clientHeight + 'px';
      respond('resizePrepared');
    }
  };

  /**
   * Resize parent and iframe to desired height.
   *
   * @private
   * @param {Object} iframe Element
   * @param {Object} data Payload
   * @param {Function} respond Send a response to the iframe
   */
  actionHandlers.resize = function (iframe, data) {
    // Resize iframe so all content is visible. Use scrollHeight to make sure we get everything
    iframe.style.height = data.scrollHeight + 'px';
  };

  /**
   * Handle speech recognition start request from iframe.
   *
   * @private
   * @param {Object} iframe Element
   * @param {Object} data Payload
   * @param {Function} respond Send a response to the iframe
   */
  actionHandlers.speech_recognition_start = function (iframe, data, respond) {
    if (window.CoreH5PSpeechRecognitionHandler) {
      window.CoreH5PSpeechRecognitionHandler.handleStart(data, respond).catch(function(error) {
        console.error('[H5P Speech Recognition] Start error:', error);
        respond('speech_recognition_response', {
          requestId: data.requestId,
          type: 'error',
          error: 'network',
          message: error.message || 'Unknown error occurred'
        });
      });
    } else {
      respond('speech_recognition_response', {
        requestId: data.requestId,
        type: 'error',
        error: 'not-allowed',
        message: 'Speech recognition is not available'
      });
    }
  };

  /**
   * Handle speech recognition stop request from iframe.
   *
   * @private
   * @param {Object} iframe Element
   * @param {Object} data Payload
   * @param {Function} respond Send a response to the iframe
   */
  actionHandlers.speech_recognition_stop = function (iframe, data, respond) {
    if (window.CoreH5PSpeechRecognitionHandler) {
      window.CoreH5PSpeechRecognitionHandler.handleStop(data, respond).catch(function(error) {
        console.error('[H5P Speech Recognition] Stop error:', error);
        // Don't send error response for stop - just log it
      });
    }
  };

  /**
   * Handle speech recognition abort request from iframe.
   *
   * @private
   * @param {Object} iframe Element
   * @param {Object} data Payload
   * @param {Function} respond Send a response to the iframe
   */
  actionHandlers.speech_recognition_abort = function (iframe, data, respond) {
    if (window.CoreH5PSpeechRecognitionHandler) {
      window.CoreH5PSpeechRecognitionHandler.handleAbort(data, respond).catch(function(error) {
        console.error('[H5P Speech Recognition] Abort error:', error);
        // Don't send error response for abort - just log it
      });
    }
  };

  /**
   * Keyup event handler. Exits full screen on escape.
   *
   * @param {Event} event
   */
  var escape = function (event) {
    if (event.keyCode === 27) {
      exitFullScreen();
    }
  };

  /**
   * Check if origin is allowed for H5P content.
   *
   * @param {string} origin Origin to check
   * @returns {boolean} True if origin is allowed
   */
  function isOriginAllowed(origin) {
    // Allow same origin
    if (origin === window.location.origin) {
      return true;
    }

    // Allow file protocol for local content
    if (origin === 'file://') {
      return true;
    }

    // Allow app custom scheme
    if (origin.indexOf('moodleappfs://') === 0) {
      return true;
    }

    // Reject null origin - sandboxed iframes are not supported for security reasons
    // If sandboxed iframe support is needed, implement proper src attribute validation
    if (origin === 'null') {
      console.warn('[H5P Security] Rejecting null origin (sandboxed iframe not supported)');
      return false;
    }

    return false;
  }

  // Listen for messages from iframes
  window.addEventListener('message', function receiveMessage(event) {
    // SECURITY FIX: Validate message structure first
    if (!event || !event.data || typeof event.data !== 'object') {
      return;
    }

    if (event.data.context !== 'h5p') {
      return; // Only handle h5p requests.
    }

    // SECURITY FIX: Validate origin
    if (!isOriginAllowed(event.origin)) {
      console.warn('[H5P Security] Blocked message from untrusted origin:', event.origin);
      return;
    }

    // SECURITY FIX: Validate action is a safe string
    if (typeof event.data.action !== 'string' || !event.data.action) {
      console.warn('[H5P Security] Invalid action type');
      return;
    }

    // Find out who sent the message
    var iframe, iframes = document.getElementsByTagName('iframe');
    for (var i = 0; i < iframes.length; i++) {
      if (iframes[i] && iframes[i].contentWindow === event.source) {
        iframe = iframes[i];
        break;
      }
    }

    if (!iframe) {
      console.warn('[H5P] Message from unknown source');
      return; // Cannot find sender
    }

    // SECURITY FIX: Prevent prototype pollution - use hasOwnProperty check
    if (Object.prototype.hasOwnProperty.call(actionHandlers, event.data.action) &&
        typeof actionHandlers[event.data.action] === 'function') {
      try {
        actionHandlers[event.data.action](iframe, event.data, function respond(action, data) {
          if (data === undefined) {
            data = {};
          }
          data.action = action;
          data.context = 'h5p';

          // CRITICAL FIX: Check if iframe still exists before postMessage
          if (!event.source || !event.source.postMessage) {
            console.warn('[H5P] Cannot respond - iframe window destroyed');
            return;
          }

          // SECURITY FIX: Use specific origin instead of wildcard
          event.source.postMessage(data, event.origin);
        });
      } catch (error) {
        console.error('[H5P] Error handling action:', event.data.action, error);
      }
    } else {
      console.warn('[H5P] Unknown or invalid action:', event.data.action);
    }
  }, false);

  // Let h5p iframes know we're ready!
  var iframes = document.getElementsByTagName('iframe');
  var ready = {
    context: 'h5p',
    action: 'ready'
  };
  for (var i = 0; i < iframes.length; i++) {
    if (iframes[i] && iframes[i].src && iframes[i].src.indexOf('h5p') !== -1) {
      if (iframes[i].contentWindow) {
        try {
          // SECURITY FIX: Try to determine origin, fallback to wildcard only if needed
          var iframeOrigin = '*';
          try {
            if (iframes[i].src) {
              var url = new URL(iframes[i].src);
              iframeOrigin = url.origin;
            }
          } catch (e) {
            // Invalid URL or cross-origin, use wildcard
            iframeOrigin = '*';
          }

          iframes[i].contentWindow.postMessage(ready, iframeOrigin);
        } catch (error) {
          console.warn('[H5P] Could not send ready message to iframe:', error);
        }
      }
    }
  }

})();
