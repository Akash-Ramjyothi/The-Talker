/**
 * Enhanced Speech Synthesis Engine with Multi-Provider Support
 * Supports: Browser TTS, Google Translate, Google Wavenet, Amazon Polly, IBM Watson
 * @version 2.0.0
 */

class Speech {
  constructor(texts, options = {}) {
    this.options = {
      rate: 1.0,
      pitch: 1.0,
      volume: 1.0,
      lang: 'en-US',
      voice: null,
      onStart: null,
      onEnd: null,
      onError: null,
      onBoundary: null,
      ...options
    };

    // Apply rate adjustment for Google Native voices
    if (this.options.voice && this.isGoogleNative(this.options.voice)) {
      this.options.rate = (this.options.rate || 1) * 0.9;
    }

    // Normalize texts with proper punctuation
    this.texts = this.normalizeTexts(Array.isArray(texts) ? texts : [texts]);
    
    // Split into manageable chunks
    if (this.texts.length) {
      this.texts = this.getChunks(this.texts.join('\n\n'));
    }

    this.state = 'IDLE';
    this.currentIndex = 0;
    this.pauseDuration = 650 / this.options.rate;
    this.delayedPlayTimer = null;
    this.engine = null;
    this.startTime = null;
    
    // Initialize engine asynchronously
    this.ready = this.initEngine();
  }

  // Public API
  async play() {
    if (this.currentIndex >= this.texts.length) {
      this.state = 'IDLE';
      this.options.onEnd?.();
      return;
    }

    if (this.state === 'PAUSED') {
      this.state = 'PLAYING';
      await this.engine.resume();
      return;
    }

    this.state = 'PLAYING';
    this.startTime = Date.now();
    
    await this.ready;
    await this.speakChunk();
  }

  async pause() {
    await this.ready;
    
    if (this.canPause()) {
      clearTimeout(this.delayedPlayTimer);
      await this.engine.pause();
      this.state = 'PAUSED';
    } else {
      await this.stop();
    }
  }

  async stop() {
    await this.ready;
    clearTimeout(this.delayedPlayTimer);
    await this.engine.stop();
    this.state = 'IDLE';
    this.currentIndex = 0;
  }

  async forward() {
    if (this.currentIndex + 1 < this.texts.length) {
      this.currentIndex++;
      return this.delayedPlay();
    }
    throw new Error('Cannot forward: already at end');
  }

  async rewind() {
    if (this.state === 'PLAYING' && Date.now() - this.startTime > 3000) {
      await this.stop();
      return this.play();
    }
    
    if (this.currentIndex > 0) {
      this.currentIndex--;
      await this.stop();
      return this.play();
    }
    
    throw new Error('Cannot rewind: already at beginning');
  }

  async seek(index) {
    if (index >= 0 && index < this.texts.length) {
      this.currentIndex = index;
      await this.stop();
      return this.play();
    }
    throw new Error(`Invalid seek index: ${index}`);
  }

  gotoEnd() {
    this.currentIndex = Math.max(0, this.texts.length - 1);
  }

  getState() {
    if (!this.engine) return 'LOADING';
    
    return new Promise((resolve) => {
      this.engine.isSpeaking((isSpeaking) => {
        if (this.state === 'PLAYING') {
          resolve(isSpeaking ? 'PLAYING' : 'LOADING');
        } else {
          resolve('PAUSED');
        }
      });
    });
  }

  getPosition() {
    return {
      index: this.currentIndex,
      total: this.texts.length,
      progress: this.currentIndex / this.texts.length,
      texts: this.texts
    };
  }

  // Private methods
  async initEngine() {
    const engine = await this.pickEngine();
    this.engine = engine;
    return engine;
  }

  async pickEngine() {
    const voice = this.options.voice;
    
    if (!voice) {
      return this.createBrowserEngine();
    }
    
    if (this.isGoogleTranslate(voice) && !/\s(Hebrew|Telugu)$/.test(voice.voiceName)) {
      try {
        await googleTranslateTtsEngine.ready();
        return googleTranslateTtsEngine;
      } catch (err) {
        console.error('Google Translate TTS failed:', err);
        this.options.voice.autoSelect = true;
        return this.createRemoteEngine();
      }
    }
    
    if (this.isAmazonPolly(voice)) return amazonPollyTtsEngine;
    if (this.isGoogleWavenet(voice)) return googleWavenetTtsEngine;
    if (this.isIbmWatson(voice)) return ibmWatsonTtsEngine;
    if (this.isRemoteVoice(voice)) return this.createRemoteEngine();
    if (this.isGoogleNative(voice)) {
      return new TimeoutTtsEngine(this.createBrowserEngine(), 16000);
    }
    
    return this.createBrowserEngine();
  }

  createBrowserEngine() {
    return new BrowserTtsEngine(window.speechSynthesis);
  }

  createRemoteEngine() {
    return remoteTtsEngine;
  }

  normalizeTexts(texts) {
    return texts.map(text => {
      // Ensure sentences end with punctuation
      if (/[\w)]$/.test(text)) {
        return text + '.';
      }
      return text;
    });
  }

  getChunks(text) {
    const isEA = /^zh|ko|ja/.test(this.options.lang);
    const punctuator = isEA ? new EastAsianPunctuator() : new LatinPunctuator();
    
    if (this.isGoogleNative(this.options.voice)) {
      const wordLimit = (/^(de|ru|es|id)/.test(this.options.lang) ? 32 : 36) * (isEA ? 2 : 1) * this.options.rate;
      return new WordBreaker(wordLimit, punctuator).breakText(text);
    }
    
    if (this.isGoogleTranslate(this.options.voice)) {
      return new CharBreaker(200, punctuator).breakText(text);
    }
    
    return new CharBreaker(750, punctuator, 200).breakText(text);
  }

  async speakChunk() {
    const text = this.texts[this.currentIndex];
    
    // Prefetch next chunk for smoother playback
    if (this.texts[this.currentIndex + 1] && this.engine.prefetch) {
      this.engine.prefetch(this.texts[this.currentIndex + 1], this.options);
    }
    
    try {
      await this.speak(text);
      
      // Schedule next chunk
      if (this.engine.setNextStartTime) {
        this.engine.setNextStartTime(Date.now() + this.pauseDuration, this.options);
      }
      
      this.currentIndex++;
      await this.play();
    } catch (error) {
      this.state = 'IDLE';
      this.options.onError?.(error);
    }
  }

  speak(text) {
    return new Promise((resolve, reject) => {
      let speakState = 'IDLE';
      
      this.engine.speak(text, this.options, (event) => {
        switch (event.type) {
          case 'start':
            if (speakState === 'IDLE') {
              this.options.onStart?.();
              speakState = 'STARTED';
              resolve();
            }
            break;
            
          case 'end':
            if (speakState === 'IDLE') {
              reject(new Error('TTS engine end event before start event'));
            } else if (speakState === 'STARTED') {
              this.options.onEnd?.();
              speakState = 'ENDED';
            }
            break;
            
          case 'boundary':
            this.options.onBoundary?.(event);
            break;
            
          case 'error':
            if (speakState === 'IDLE') {
              reject(new Error(event.errorMessage || 'Unknown TTS error'));
            } else if (speakState === 'STARTED') {
              this.options.onError?.(new Error(event.errorMessage || 'Unknown TTS error'));
            }
            speakState = 'ERROR';
            break;
        }
      });
    });
  }

  delayedPlay() {
    clearTimeout(this.delayedPlayTimer);
    this.delayedPlayTimer = setTimeout(async () => {
      await this.stop();
      await this.play();
    }, 750);
  }

  canPause() {
    return this.engine?.pause && !(
      this.isChromeOSNative(this.options.voice) ||
      this.options.voice?.voiceName === 'US English Female TTS (by Google)'
    );
  }

  // Voice detection helpers
  isGoogleTranslate(voice) {
    return voice?.provider === 'google-translate';
  }

  isGoogleWavenet(voice) {
    return voice?.provider === 'google-wavenet';
  }

  isGoogleNative(voice) {
    return voice?.provider === 'google-native';
  }

  isAmazonPolly(voice) {
    return voice?.provider === 'amazon-polly';
  }

  isIbmWatson(voice) {
    return voice?.provider === 'ibm-watson';
  }

  isRemoteVoice(voice) {
    return voice?.remote === true;
  }

  isChromeOSNative(voice) {
    return voice?.platform === 'chromeos';
  }
}

// Enhanced Text Breakers with better language support
class WordBreaker {
  constructor(wordLimit, punctuator) {
    this.wordLimit = wordLimit;
    this.punctuator = punctuator;
  }

  breakText(text) {
    return this.merge(
      this.punctuator.getParagraphs(text),
      (p) => this.breakParagraph(p)
    );
  }

  breakParagraph(text) {
    return this.merge(
      this.punctuator.getSentences(text),
      (s) => this.breakSentence(s)
    );
  }

  breakSentence(sentence) {
    return this.merge(
      this.punctuator.getPhrases(sentence),
      (p) => this.breakPhrase(p)
    );
  }

  breakPhrase(phrase) {
    const words = this.punctuator.getWords(phrase);
    const splitPoint = Math.min(Math.ceil(words.length / 2), this.wordLimit);
    const result = [];
    
    for (let i = 0; i < words.length; i += splitPoint) {
      result.push(words.slice(i, i + splitPoint).join(''));
    }
    
    return result;
  }

  merge(parts, breakPart) {
    const result = [];
    let group = { parts: [], wordCount: 0 };
    
    const flush = () => {
      if (group.parts.length) {
        result.push(group.parts.join(''));
        group = { parts: [], wordCount: 0 };
      }
    };
    
    for (const part of parts) {
      const wordCount = this.punctuator.getWords(part).length;
      
      if (wordCount > this.wordLimit) {
        flush();
        const subParts = breakPart(part);
        result.push(...subParts);
      } else {
        if (group.wordCount + wordCount > this.wordLimit) flush();
        group.parts.push(part);
        group.wordCount += wordCount;
      }
    }
    
    flush();
    return result;
  }
}

class CharBreaker {
  constructor(charLimit, punctuator, paragraphCombineThreshold = null) {
    this.charLimit = charLimit;
    this.punctuator = punctuator;
    this.paragraphCombineThreshold = paragraphCombineThreshold;
  }

  breakText(text) {
    return this.merge(
      this.punctuator.getParagraphs(text),
      (p) => this.breakParagraph(p),
      this.paragraphCombineThreshold
    );
  }

  breakParagraph(text) {
    return this.merge(
      this.punctuator.getSentences(text),
      (s) => this.breakSentence(s)
    );
  }

  breakSentence(sentence) {
    return this.merge(
      this.punctuator.getPhrases(sentence),
      (p) => this.breakPhrase(p)
    );
  }

  breakPhrase(phrase) {
    return this.merge(
      this.punctuator.getWords(phrase),
      (w) => this.breakWord(w)
    );
  }

  breakWord(word) {
    const result = [];
    for (let i = 0; i < word.length; i += this.charLimit) {
      result.push(word.slice(i, i + this.charLimit));
    }
    return result;
  }

  merge(parts, breakPart, combineThreshold) {
    const result = [];
    let group = { parts: [], charCount: 0 };
    const threshold = combineThreshold || this.charLimit;
    
    const flush = () => {
      if (group.parts.length) {
        result.push(group.parts.join(''));
        group = { parts: [], charCount: 0 };
      }
    };
    
    for (const part of parts) {
      const charCount = part.length;
      
      if (charCount > this.charLimit) {
        flush();
        const subParts = breakPart(part);
        result.push(...subParts);
      } else {
        if (group.charCount + charCount > threshold) flush();
        group.parts.push(part);
        group.charCount += charCount;
      }
    }
    
    flush();
    return result;
  }
}

// Enhanced Punctuators with better language detection
class LatinPunctuator {
  constructor() {
    // Common abbreviations that shouldn't end sentences
    this.abbreviations = new Set([
      'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Rev', 'Hon', 'Capt', 'Col', 'Gen',
      'Lt', 'Sgt', 'Cpl', 'Ltd', 'Inc', 'Corp', 'Assn', 'Univ', 'Dept',
      'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
      'vs', 'vol', 'ed', 'est', 'tel', 'fax', 'e.g', 'i.e', 'et al'
    ]);
  }

  getParagraphs(text) {
    return this.recombine(text.split(/((?:\r?\n\s*){2,})/));
  }

  getSentences(text) {
    const regex = /([.!?]+[\s\u200b]+)/;
    return this.recombine(text.split(regex), (part) => this.isAbbreviation(part));
  }

  getPhrases(sentence) {
    return this.recombine(sentence.split(/([,;:]\s+|\s-+\s+|—\s*)/));
  }

  getWords(text) {
    const tokens = text.trim().split(/([~@#%^*_+=<>]|[\s\-—/]+|\.(?=\w{2,})|,(?=[0-9]))/);
    const result = [];
    
    for (let i = 0; i < tokens.length; i += 2) {
      if (tokens[i]) result.push(tokens[i]);
      if (i + 1 < tokens.length && /^[~@#%^*_+=<>]$/.test(tokens[i + 1])) {
        result.push(tokens[i + 1]);
      } else if (i + 1 < tokens.length && result.length) {
        result[result.length - 1] += tokens[i + 1];
      }
    }
    
    return result;
  }

  isAbbreviation(text) {
    const clean = text.trim().replace(/[.!?]$/, '');
    return this.abbreviations.has(clean);
  }

  recombine(tokens, nonPunc = null) {
    const result = [];
    
    for (let i = 0; i < tokens.length; i += 2) {
      const part = i + 1 < tokens.length ? tokens[i] + tokens[i + 1] : tokens[i];
      
      if (part) {
        if (nonPunc && result.length && nonPunc(result[result.length - 1])) {
          result[result.length - 1] += part;
        } else {
          result.push(part);
        }
      }
    }
    
    return result;
  }
}

class EastAsianPunctuator {
  getParagraphs(text) {
    return this.recombine(text.split(/((?:\r?\n\s*){2,})/));
  }

  getSentences(text) {
    return this.recombine(text.split(/([.!?]+[\s\u200b]+|[\u3002\uff01]+)/));
  }

  getPhrases(sentence) {
    return this.recombine(sentence.split(/([,;:]\s+|[\u2025\u2026\u3000\u3001\uff0c\uff1b]+)/));
  }

  getWords(sentence) {
    // For CJK languages, split into individual characters
    return sentence.replace(/\s+/g, '').split('');
  }

  recombine(tokens) {
    const result = [];
    
    for (let i = 0; i < tokens.length; i += 2) {
      if (i + 1 < tokens.length) {
        result.push(tokens[i] + tokens[i + 1]);
      } else if (tokens[i]) {
        result.push(tokens[i]);
      }
    }
    
    return result;
  }
}

// Browser TTS Engine wrapper
class BrowserTtsEngine {
  constructor(speechSynthesis) {
    this.speechSynthesis = speechSynthesis;
    this.currentUtterance = null;
  }

  speak(text, options, callback) {
    this.stop();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = options.lang;
    utterance.rate = options.rate;
    utterance.pitch = options.pitch;
    utterance.volume = options.volume;
    
    if (options.voice?.voiceURI) {
      utterance.voice = options.voice;
    }
    
    utterance.onstart = () => callback({ type: 'start' });
    utterance.onend = () => callback({ type: 'end' });
    utterance.onerror = (event) => callback({ type: 'error', errorMessage: event.error });
    utterance.onboundary = (event) => callback({ type: 'boundary', ...event });
    
    this.currentUtterance = utterance;
    this.speechSynthesis.speak(utterance);
  }

  stop() {
    if (this.currentUtterance) {
      this.speechSynthesis.cancel();
      this.currentUtterance = null;
    }
  }

  pause() {
    this.speechSynthesis.pause();
  }

  resume() {
    this.speechSynthesis.resume();
  }

  isSpeaking(callback) {
    callback(this.speechSynthesis.speaking);
  }
}

// Timeout TTS Engine wrapper for handling hanging utterances
class TimeoutTtsEngine {
  constructor(baseEngine, timeoutMs) {
    this.baseEngine = baseEngine;
    this.timeoutMs = timeoutMs;
    this.timeoutId = null;
  }

  speak(text, options, callback) {
    let completed = false;
    
    const wrappedCallback = (event) => {
      if (event.type === 'start' || event.type === 'end') {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
      }
      
      if (event.type === 'end' || event.type === 'error') {
        completed = true;
      }
      
      callback(event);
    };
    
    this.timeoutId = setTimeout(() => {
      if (!completed) {
        console.warn('TTS engine timeout, forcing stop');
        this.stop();
        callback({ type: 'error', errorMessage: 'TTS timeout' });
      }
    }, this.timeoutMs);
    
    this.baseEngine.speak(text, options, wrappedCallback);
  }

  stop() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.baseEngine.stop();
  }

  pause() {
    this.baseEngine.pause();
  }

  resume() {
    this.baseEngine.resume();
  }

  isSpeaking(callback) {
    this.baseEngine.isSpeaking(callback);
  }
}

// Export for different environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Speech, WordBreaker, CharBreaker, LatinPunctuator, EastAsianPunctuator };
}
