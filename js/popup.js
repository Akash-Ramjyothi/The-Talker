/**
 * Enhanced Read Aloud Popup Controller
 * Manages playback controls, text highlighting, and user interactions
 * @version 2.0.0
 */

// Global state management
let showGotoPage;
let refreshInterval;
let pendingOperations = new Map();
let debounceTimers = new Map();

$(function() {
  initializeEventListeners();
  initializeKeyboardShortcuts();
  initializeAccessibility();
  
  updateButtons()
    .then(() => bgPageInvoke('getPlaybackState'))
    .then(state => {
      if (state !== 'PLAYING') {
        // Auto-play only if configured
        getSettings(['autoPlayOnOpen']).then(settings => {
          if (settings.autoPlayOnOpen !== false) {
            $('#btnPlay').click();
          }
        });
      }
    });
  
  // Optimized update interval
  refreshInterval = setInterval(() => updateButtons(), 300);
  
  refreshSize();
  checkAnnouncements();
  checkForUpdates();
  initializeTooltips();
  setupDragResize();
});

// Cleanup on unload
$(window).on('unload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
  debounceTimers.forEach(timer => clearTimeout(timer));
  pendingOperations.clear();
});

function initializeEventListeners() {
  // Main controls
  $('#btnPlay').click(onPlay);
  $('#btnPause').click(onPause);
  $('#btnStop').click(onStop);
  $('#btnSettings').click(onSettings);
  $('#btnForward').click(onForward);
  $('#btnRewind').click(onRewind);
  
  // Size controls
  $('#decrease-font-size').click(() => changeFontSize(-1));
  $('#increase-font-size').click(() => changeFontSize(1));
  $('#decrease-window-size').click(() => changeWindowSize(-1));
  $('#increase-window-size').click(() => changeWindowSize(1));
  
  // Additional features
  $('#btnSpeed').click(onSpeedSettings);
  $('#btnVoice').click(onVoiceSettings);
  $('#btnTheme').click(onThemeToggle);
  $('#btnFullscreen').click(onToggleFullscreen);
  $('#btnCopyText').click(onCopyText);
  $('#btnShare').click(onShare);
  
  // Keyboard navigation for highlight area
  $('#highlight').on('keydown', 'span', onHighlightKeyNavigation);
  
  // Touch events for mobile
  if (isMobileOS()) {
    initializeTouchEvents();
  }
}

function initializeKeyboardShortcuts() {
  $(document).on('keydown', (e) => {
    // Space bar: Play/Pause
    if (e.code === 'Space' && !e.target.matches('input, textarea, button')) {
      e.preventDefault();
      const state = $('#btnPlay').is(':visible') ? 'PLAY' : 'PAUSE';
      if (state === 'PLAY') onPlay();
      else onPause();
    }
    // Right arrow: Forward
    else if (e.code === 'ArrowRight' && e.ctrlKey) {
      e.preventDefault();
      onForward();
    }
    // Left arrow: Rewind
    else if (e.code === 'ArrowLeft' && e.ctrlKey) {
      e.preventDefault();
      onRewind();
    }
    // Escape: Stop
    else if (e.code === 'Escape') {
      onStop();
    }
    // S: Settings
    else if (e.code === 'KeyS' && e.ctrlKey) {
      e.preventDefault();
      onSettings();
    }
  });
}

function initializeAccessibility() {
  // ARIA labels and roles
  $('#btnPlay').attr('aria-label', 'Play');
  $('#btnPause').attr('aria-label', 'Pause');
  $('#btnStop').attr('aria-label', 'Stop');
  $('#btnForward').attr('aria-label', 'Forward');
  $('#btnRewind').attr('aria-label', 'Rewind');
  $('#btnSettings').attr('aria-label', 'Settings');
  
  // Announce status changes to screen readers
  const statusObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'style' || mutation.attributeName === 'class') {
        const status = getCurrentPlaybackStatus();
        announceToScreenReader(`Playback ${status}`);
      }
    });
  });
  
  statusObserver.observe($('#btnPlay')[0], { attributes: true });
  statusObserver.observe($('#btnPause')[0], { attributes: true });
}

function initializeTooltips() {
  $('[data-tooltip]').each(function() {
    const $this = $(this);
    const tooltipText = $this.data('tooltip');
    if (tooltipText) {
      $this.attr('title', tooltipText);
      // Enhanced tooltip for modern browsers
      if (typeof browser !== 'undefined' && browser.tooltips) {
        browser.tooltips.create({ target: this, text: tooltipText });
      }
    }
  });
}

function setupDragResize() {
  let isResizing = false;
  let startX, startY, startWidth, startHeight;
  
  $('#resize-handle').on('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startWidth = $('#highlight').width();
    startHeight = $('#highlight').height();
    
    $(document).on('mousemove', onMouseMove);
    $(document).on('mouseup', onMouseUp);
    e.preventDefault();
  });
  
  function onMouseMove(e) {
    if (!isResizing) return;
    const newWidth = startWidth + (e.clientX - startX);
    const newHeight = startHeight + (e.clientY - startY);
    
    if (newWidth >= 300 && newWidth <= 1200) {
      $('#highlight').width(newWidth);
    }
    if (newHeight >= 200 && newHeight <= 800) {
      $('#highlight').height(newHeight);
    }
  }
  
  function onMouseUp() {
    isResizing = false;
    $(document).off('mousemove', onMouseMove);
    $(document).off('mouseup', onMouseUp);
    
    // Save custom size
    updateSettings({ customHighlightSize: { width: $('#highlight').width(), height: $('#highlight').height() } });
  }
}

function initializeTouchEvents() {
  let touchStartX = 0;
  let touchStartY = 0;
  
  $('#highlight').on('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  });
  
  $('#highlight').on('touchend', (e) => {
    const touchEndX = e.changedTouches[0].clientX;
    const touchEndY = e.changedTouches[0].clientY;
    const deltaX = touchEndX - touchStartX;
    const deltaY = touchEndY - touchStartY;
    
    if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX > 0) onRewind();
      else onForward();
    }
  });
}

function handleError(err, context = '') {
  if (!err) return;
  
  console.error(`Error in ${context}:`, err);
  
  if (/^{/.test(err.message)) {
    try {
      const errInfo = JSON.parse(err.message);
      showErrorDialog(formatError(errInfo), errInfo);
      
      // Handle specific error actions
      if (errInfo.link) {
        handleErrorAction(errInfo);
      }
    } catch (e) {
      showErrorNotification(err.message);
    }
  } else {
    showErrorNotification(err.message);
  }
}

function showErrorDialog(message, errInfo) {
  const $dialog = $(`
    <div class="error-dialog">
      <div class="error-dialog-content">
        <span class="close-btn">&times;</span>
        <div class="error-icon">⚠️</div>
        <div class="error-message">${message}</div>
        ${errInfo.actions ? renderErrorActions(errInfo.actions) : ''}
      </div>
    </div>
  `);
  
  $dialog.find('.close-btn').click(() => $dialog.remove());
  $dialog.find('.action-btn').click(function() {
    const action = $(this).data('action');
    executeErrorAction(action, errInfo);
    $dialog.remove();
  });
  
  $('body').append($dialog);
  setTimeout(() => $dialog.addClass('show'), 10);
}

function renderErrorActions(actions) {
  return actions.map(action => `
    <button class="action-btn" data-action="${action.id}">
      ${action.label}
    </button>
  `).join('');
}

function executeErrorAction(actionId, errInfo) {
  switch (actionId) {
    case 'open-settings':
      brapi.tabs.create({ url: 'chrome://extensions/?id=' + brapi.runtime.id });
      break;
    case 'request-permissions':
      requestPermissions(errInfo.perms).then(granted => {
        if (granted) onPlay();
      });
      break;
    case 'sign-in':
      getBackgroundPage()
        .then(callMethod('getAuthToken', { interactive: true }))
        .then(token => {
          if (token) onPlay();
        })
        .catch(err => handleError(err, 'Sign in'));
      break;
    case 'auth-wavenet':
      requestPermissions(config.wavenetPerms)
        .then(granted => {
          if (granted) bgPageInvoke('authWavenet');
        });
      break;
    case 'user-gesture':
      getBackgroundPage()
        .then(callMethod('userGestureActivate'))
        .then(() => onPlay());
      break;
    default:
      if (errInfo.url) {
        setTabUrl(undefined, errInfo.url);
      }
  }
}

function showErrorNotification(message) {
  const $notification = $(`
    <div class="notification error">
      <span>${escapeHtml(message)}</span>
      <button class="notification-close">×</button>
    </div>
  `);
  
  $notification.find('.notification-close').click(() => $notification.remove());
  $('body').append($notification);
  
  setTimeout(() => $notification.addClass('show'), 10);
  setTimeout(() => {
    $notification.removeClass('show');
    setTimeout(() => $notification.remove(), 300);
  }, 5000);
}

function updateButtons() {
  const operationId = 'updateButtons_' + Date.now();
  pendingOperations.set(operationId, true);
  
  return Promise.all([
    getSettings(),
    bgPageInvoke('getPlaybackState').catch(err => ({ error: err })),
    bgPageInvoke('getSpeechPosition').catch(err => ({ error: err }))
  ])
  .then(spread((settings, playbackState, speechPos) => {
    pendingOperations.delete(operationId);
    
    const state = playbackState.error ? 'STOPPED' : playbackState;
    const position = speechPos.error ? null : speechPos;
    
    updateUIState(settings, state, position);
    
    // Update browser action badge
    updateBrowserBadge(state);
    
    // Track analytics
    trackPlaybackState(state);
    
    return { settings, state, position };
  }))
  .catch(err => {
    pendingOperations.delete(operationId);
    handleError(err, 'updateButtons');
  });
}

function updateUIState(settings, state, speechPos) {
  // Show/hide loading indicator
  $('#imgLoading').toggle(state === 'LOADING');
  
  // Main control buttons
  $('#btnSettings').toggle(state === 'STOPPED');
  $('#btnPlay').toggle(state === 'PAUSED' || state === 'STOPPED');
  $('#btnPause').toggle(state === 'PLAYING');
  $('#btnStop').toggle(['PAUSED', 'PLAYING', 'LOADING'].includes(state));
  $('#btnForward, #btnRewind').toggle(['PLAYING', 'PAUSED'].includes(state));
  
  // Speed and voice controls
  const showAdvanced = state !== 'LOADING';
  $('#btnSpeed, #btnVoice, #btnTheme, #btnFullscreen').toggle(showAdvanced);
  
  // Highlighting
  const showHighlighting = (settings.showHighlighting !== undefined ? settings.showHighlighting : defaults.showHighlighting);
  const showHighlightControls = showHighlighting && ['LOADING', 'PAUSED', 'PLAYING'].includes(state);
  
  $('#highlight, #toolbar, #resize-handle').toggle(showHighlightControls);
  
  // Update highlight content
  if (showHighlighting && speechPos && !speechPos.error) {
    updateHighlightContent(speechPos);
  }
  
  // Update progress bar if exists
  if (settings.showProgressBar !== false) {
    updateProgressBar(speechPos);
  }
}

function updateHighlightContent(speechPos) {
  const $elem = $('#highlight');
  const pos = speechPos;
  
  // Check if text content changed
  const textsChanged = !$elem.data('texts') || 
                       $elem.data('texts').length !== pos.texts.length ||
                       $elem.data('texts').some((text, i) => text !== pos.texts[i]);
  
  if (textsChanged) {
    $elem.data({ texts: pos.texts, index: -1 });
    $elem.empty();
    
    // Use DocumentFragment for better performance
    const fragment = document.createDocumentFragment();
    
    pos.texts.forEach((text, i) => {
      const html = escapeHtml(text).replace(/\r?\n/g, '<br/>');
      const $span = $('<span>')
        .html(html)
        .css('cursor', 'pointer')
        .attr('data-index', i)
        .attr('role', 'button')
        .attr('tabindex', 0)
        .attr('aria-label', `Go to section ${i + 1} of ${pos.texts.length}`)
        .on('click', () => onSeek(i))
        .on('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSeek(i);
          }
        });
      
      fragment.appendChild($span[0]);
    });
    
    $elem[0].appendChild(fragment);
  }
  
  // Update active highlight
  if ($elem.data('index') !== pos.index) {
    $elem.data('index', pos.index);
    $elem.children('.active').removeClass('active');
    
    const $child = $elem.children().eq(pos.index).addClass('active');
    
    if ($child.length) {
      // Smooth scroll to active element
      const childTop = $child.position().top;
      const childBottom = childTop + $child.outerHeight();
      const elemHeight = $elem.height();
      
      if (childTop < 0 || childBottom >= elemHeight) {
        $elem.animate({
          scrollTop: $elem.scrollTop() + childTop - (elemHeight / 3)
        }, 300);
      }
      
      // Announce current position to screen readers
      announceToScreenReader(`Now reading: section ${pos.index + 1} of ${pos.texts.length}`);
    }
  }
}

function updateProgressBar(speechPos) {
  if (!speechPos || speechPos.error) return;
  
  let $progressBar = $('#progress-bar');
  if (!$progressBar.length) {
    $progressBar = $('<div id="progress-bar"><div class="progress-fill"></div></div>');
    $('#toolbar').append($progressBar);
  }
  
  const progress = (speechPos.index + 1) / speechPos.texts.length;
  $progressBar.find('.progress-fill').css('width', `${progress * 100}%`);
}

function updateBrowserBadge(state) {
  if (typeof browser !== 'undefined' && browser.action) {
    const badgeText = {
      'PLAYING': '▶',
      'PAUSED': '⏸',
      'LOADING': '⏳',
      'STOPPED': '⏹'
    }[state] || '';
    
    browser.action.setBadgeText({ text: badgeText });
    browser.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  }
}

function announceToScreenReader(message) {
  let $announcer = $('#sr-announcer');
  if (!$announcer.length) {
    $announcer = $('<div id="sr-announcer" aria-live="polite" class="sr-only"></div>');
    $('body').append($announcer);
  }
  $announcer.text(message);
  setTimeout(() => $announcer.empty(), 1000);
}

function getCurrentPlaybackStatus() {
  if ($('#btnPlay').is(':visible')) return 'stopped';
  if ($('#btnPause').is(':visible')) return 'playing';
  if ($('#imgLoading').is(':visible')) return 'loading';
  return 'paused';
}

function trackPlaybackState(state) {
  // Analytics tracking (if enabled)
  if (typeof ga !== 'undefined' && settings.analyticsEnabled !== false) {
    ga('send', 'event', 'playback', 'state', state);
  }
}

// Enhanced control functions with debouncing
const onPlay = debounce(() => {
  $('#status, .error-dialog, .notification').hide();
  bgPageInvoke('play')
    .then(() => updateButtons())
    .catch(err => handleError(err, 'Play'));
}, 300);

const onPause = debounce(() => {
  bgPageInvoke('pause')
    .then(() => updateButtons())
    .catch(err => handleError(err, 'Pause'));
}, 300);

const onStop = debounce(() => {
  bgPageInvoke('stop')
    .then(() => updateButtons())
    .catch(err => handleError(err, 'Stop'));
}, 300);

const onSettings = debounce(() => {
  location.href = 'options.html?referer=popup.html';
}, 300);

const onForward = debounce(() => {
  bgPageInvoke('forward')
    .then(() => updateButtons())
    .catch(err => handleError(err, 'Forward'));
}, 300);

const onRewind = debounce(() => {
  bgPageInvoke('rewind')
    .then(() => updateButtons())
    .catch(err => handleError(err, 'Rewind'));
}, 300);

function onSeek(n) {
  bgPageInvoke('seek', [n])
    .then(() => updateButtons())
    .catch(err => handleError(err, 'Seek'));
}

function onSpeedSettings() {
  // Show speed slider
  showSpeedDialog();
}

function onVoiceSettings() {
  // Show voice selector
  showVoiceDialog();
}

function onThemeToggle() {
  getSettings(['theme']).then(settings => {
    const newTheme = settings.theme === 'dark' ? 'light' : 'dark';
    updateSettings({ theme: newTheme }).then(() => applyTheme(newTheme));
  });
}

function onToggleFullscreen() {
  const elem = document.documentElement;
  if (!document.fullscreenElement) {
    elem.requestFullscreen().catch(err => {
      handleError(err, 'Fullscreen');
    });
  } else {
    document.exitFullscreen();
  }
}

function onCopyText() {
  bgPageInvoke('getFullText')
    .then(text => {
      navigator.clipboard.writeText(text).then(() => {
        showErrorNotification('Text copied to clipboard!');
      });
    })
    .catch(err => handleError(err, 'Copy text'));
}

function onShare() {
  if (navigator.share) {
    bgPageInvoke('getPageInfo')
      .then(info => {
        navigator.share({
          title: info.title,
          text: `Check out "${info.title}" - I'm listening to it with Read Aloud`,
          url: info.url
        }).catch(err => {
          if (err.name !== 'AbortError') handleError(err, 'Share');
        });
      });
  } else {
    showErrorNotification('Share not supported on this browser');
  }
}

function showSpeedDialog() {
  const $dialog = $(`
    <div class="speed-dialog">
      <h3>Reading Speed</h3>
      <input type="range" min="0.5" max="2.5" step="0.1" value="1.0">
      <span class="speed-value">1.0x</span>
      <button class="apply-btn">Apply</button>
    </div>
  `);
  
  const $slider = $dialog.find('input');
  const $value = $dialog.find('.speed-value');
  
  getSettings(['rate']).then(settings => {
    $slider.val(settings.rate || 1.0);
    $value.text(`${settings.rate || 1.0}x`);
  });
  
  $slider.on('input', function() {
    $value.text(`${$(this).val()}x`);
  });
  
  $dialog.find('.apply-btn').click(() => {
    const rate = parseFloat($slider.val());
    updateSettings({ rate }).then(() => {
      $dialog.remove();
      showErrorNotification(`Speed set to ${rate}x`);
    });
  });
  
  $('body').append($dialog);
}

function showVoiceDialog() {
  // Fetch available voices
  bgPageInvoke('getVoices')
    .then(voices => {
      const $dialog = $(`
        <div class="voice-dialog">
          <h3>Select Voice</h3>
          <select class="voice-select">
            ${voices.map(voice => `
              <option value="${voice.voiceURI}" data-provider="${voice.provider}">
                ${voice.name} (${voice.provider || 'System'})
              </option>
            `).join('')}
          </select>
          <button class="apply-btn">Apply</button>
        </div>
      `);
      
      getSettings(['voice']).then(settings => {
        if (settings.voice) {
          $dialog.find('.voice-select').val(settings.voice.voiceURI);
        }
      });
      
      $dialog.find('.apply-btn').click(() => {
        const selectedVoice = voices.find(v => v.voiceURI === $dialog.find('.voice-select').val());
        updateSettings({ voice: selectedVoice }).then(() => {
          $dialog.remove();
          showErrorNotification('Voice changed');
        });
      });
      
      $('body').append($dialog);
    })
    .catch(err => handleError(err, 'Get voices'));
}

function applyTheme(theme) {
  if (theme === 'dark') {
    $('body').addClass('dark-theme');
  } else {
    $('body').removeClass('dark-theme');
  }
}

function onHighlightKeyNavigation(e) {
  const $spans = $('#highlight span');
  const currentIndex = $spans.index($(e.target));
  
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowRight':
      e.preventDefault();
      if (currentIndex < $spans.length - 1) {
        $spans.eq(currentIndex + 1).focus();
      }
      break;
    case 'ArrowUp':
    case 'ArrowLeft':
      e.preventDefault();
      if (currentIndex > 0) {
        $spans.eq(currentIndex - 1).focus();
      }
      break;
  }
}

function changeFontSize(delta) {
  getSettings(['highlightFontSize'])
    .then(settings => {
      const newSize = (settings.highlightFontSize || defaults.highlightFontSize) + delta;
      if (newSize >= 1 && newSize <= 8) {
        return updateSettings({ highlightFontSize: newSize }).then(refreshSize);
      }
    })
    .catch(err => handleError(err, 'Change font size'));
}

function changeWindowSize(delta) {
  getSettings(['highlightWindowSize'])
    .then(settings => {
      const newSize = (settings.highlightWindowSize || defaults.highlightWindowSize) + delta;
      if (newSize >= 1 && newSize <= 3) {
        return updateSettings({ highlightWindowSize: newSize }).then(refreshSize);
      }
    })
    .catch(err => handleError(err, 'Change window size'));
}

function refreshSize() {
  return getSettings(['highlightFontSize', 'highlightWindowSize', 'customHighlightSize'])
    .then(settings => {
      const fontSize = getFontSize(settings);
      
      if (settings.customHighlightSize && settings.customHighlightSize.width) {
        // Use custom size from drag resize
        $('#highlight').css({
          'font-size': fontSize,
          width: settings.customHighlightSize.width,
          height: settings.customHighlightSize.height
        });
      } else {
        const windowSize = getWindowSize(settings);
        $('#highlight').css({
          'font-size': fontSize,
          width: isMobileOS() ? '100%' : windowSize[0],
          height: windowSize[1]
        });
      }
    });
  
  function getFontSize(settings) {
    const sizes = { 1: '.9em', 2: '1em', 3: '1.1em', 4: '1.2em', 5: '1.3em', 6: '1.4em', 7: '1.5em', 8: '1.6em' };
    return sizes[settings.highlightFontSize || defaults.highlightFontSize] || '1.2em';
  }
  
  function getWindowSize(settings) {
    const sizes = { 1: [430, 330], 2: [550, 420], 3: [750, 450] };
    return sizes[settings.highlightWindowSize || defaults.highlightWindowSize] || [550, 420];
  }
}

function checkAnnouncements() {
  const now = Date.now();
  
  getSettings(['announcement'])
    .then(settings => {
      const ann = settings.announcement;
      if (ann && ann.expire > now) return ann;
      
      return ajaxGet(config.serviceUrl + '/read-aloud/announcement')
        .then(JSON.parse)
        .then(result => {
          result.expire = now + 6 * 3600 * 1000;
          if (ann && result.id === ann.id) {
            result.lastShown = ann.lastShown;
            result.disabled = ann.disabled;
          }
          updateSettings({ announcement: result });
          return result;
        });
    })
    .then(ann => {
      if (ann?.text && !ann.disabled) {
        if (!ann.lastShown || now - ann.lastShown > ann.period * 60 * 1000) {
          showAnnouncement(ann);
          ann.lastShown = now;
          updateSettings({ announcement: ann });
        }
      }
    })
    .catch(err => console.error('Announcement check failed:', err));
}

function showAnnouncement(ann) {
  const html = escapeHtml(ann.text)
    .replace(/\[(.*?)\]/g, `<a target='_blank' href='${ann.link}' rel='noopener noreferrer'>$1</a>`)
    .replace(/\n/g, '<br/>');
  
  const $footer = $('#footer');
  $footer.html(html).addClass('announcement show');
  
  if (ann.dismissible !== false) {
    const $closeBtn = $('<button class="announcement-close" aria-label="Close announcement">&times;</button>');
    $closeBtn.click(() => {
      if (ann.disableIfClick) {
        ann.disabled = true;
        updateSettings({ announcement: ann });
      }
      $footer.removeClass('show');
      setTimeout(() => $footer.empty(), 300);
    });
    $footer.append($closeBtn);
  }
  
  if (ann.autoHide) {
    setTimeout(() => {
      $footer.removeClass('show');
      setTimeout(() => $footer.empty(), 300);
    }, ann.autoHide * 1000);
  }
}

function checkForUpdates() {
  const lastCheck = localStorage.getItem('lastUpdateCheck');
  const now = Date.now();
  
  if (!lastCheck || now - parseInt(lastCheck) > 24 * 3600 * 1000) {
    localStorage.setItem('lastUpdateCheck', now);
    
    ajaxGet(config.serviceUrl + '/read-aloud/version')
      .then(JSON.parse)
      .then(data => {
        const currentVersion = browser.runtime.getManifest().version;
        if (isNewerVersion(data.version, currentVersion)) {
          showUpdateNotification(data);
        }
      })
      .catch(err => console.error('Update check failed:', err));
  }
}

function isNewerVersion(remote, current) {
  const remoteParts = remote.split('.').map(Number);
  const currentParts = current.split('.').map(Number);
  
  for (let i = 0; i < Math.max(remoteParts.length, currentParts.length); i++) {
    const remotePart = remoteParts[i] || 0;
    const currentPart = currentParts[i] || 0;
    if (remotePart > currentPart) return true;
    if (remotePart < currentPart) return false;
  }
  return false;
}

function showUpdateNotification(data) {
  const $notification = $(`
    <div class="notification update">
      <div class="notification-content">
        <strong>Update Available!</strong>
        <p>Version ${data.version} is now available.</p>
        ${data.releaseNotes ? `<small>${escapeHtml(data.releaseNotes)}</small>` : ''}
        <div class="notification-actions">
          <button class="update-now">Update Now</button>
          <button class="update-later">Later</button>
        </div>
      </div>
    </div>
  `);
  
  $notification.find('.update-now').click(() => {
    browser.tabs.create({ url: config.updateUrl });
    $notification.remove();
  });
  
  $notification.find('.update-later').click(() => {
    $notification.remove();
  });
  
  $('body').append($notification);
  setTimeout(() => $notification.addClass('show'), 10);
}

// Utility function for debouncing
function debounce(func, wait) {
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(debounceTimers.get(func));
      func(...args);
    };
    
    clearTimeout(debounceTimers.get(func));
    debounceTimers.set(func, setTimeout(later, wait));
  };
}

// Spread function for Promise.all results
function spread(callback) {
  return function(results) {
    return callback(...results);
  };
}

// HTML escaping
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Mobile detection
function isMobileOS() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}
