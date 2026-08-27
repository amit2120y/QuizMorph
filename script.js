// ===================== pdf.js setup =====================
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ===================== State =====================
const state = {
  screen: 'home', // home, processing, config, quiz, result, review
  pdfMeta: null, // {filename, size, pages}
  rawText: '',
  questions: [], // parsed & valid
  invalidQuestions: [], // couldn't parse fully
  settings: { shuffleQuestions:false, shuffleOptions:false, timerEnabled:false, timerMinutes:20, crt:true, animations:true, sound:false, reducedMotion:false },
  quiz: null, // {order: [questionIds in play order], answers:{}, marked:Set, current:0, timeRemaining, startTs, endTs, finished:false}
  reviewFilter: 'all', // all | wrong
  modal: null, // {type, ...}
  error: null,
  processingLines: [],
  processingPct: 0,
  ocrPagesUsed: 0,
  dragOver:false,
};

function render(){ App.render(); }

// ===================== Utilities =====================
function fisherYates(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function fmtBytes(b){
  if(b < 1024) return b + ' B';
  if(b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(2) + ' MB';
}
function fmtTime(sec){
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
  const pad = n => String(n).padStart(2,'0');
  return h>0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function optLetter(i){ return String.fromCharCode(65+i); }
function esc(str){
  const d = document.createElement('div'); d.textContent = str==null?'':String(str); return d.innerHTML;
}

// ===================== PDF Parsing =====================
// Minimum non-whitespace characters on a page's text layer before we trust it
// as "real text" rather than treating the page as scanned/image-based.
const OCR_TEXT_THRESHOLD = 20;

function extractPageLines(content){
  let lastY = null, lineText = '';
  const lines = [];
  for(const item of content.items){
    const y = item.transform[5];
    if(lastY !== null && Math.abs(y-lastY) > 2){
      lines.push(lineText.trim());
      lineText = '';
    }
    lineText += item.str + ' ';
    lastY = y;
  }
  if(lineText.trim()) lines.push(lineText.trim());
  return lines.join('\n');
}

// Extracts text page-by-page, automatically falling back to client-side OCR
// (Tesseract.js) for any page whose PDF text layer is missing or too sparse
// (scanned pages). Mixed PDFs (some text pages, some scanned) are handled
// automatically since each page is judged independently.
// progressCb receives structured events so the UI can render a live log.
async function extractTextFromPdf(file, progressCb){
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({data:buf}).promise;
  const numPages = pdf.numPages;
  let fullText = '';
  let ocrPagesUsed = 0;
  let ocrFailedPages = 0;

  for(let p=1; p<=numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let pageText = extractPageLines(content);
    const hasRealText = pageText.replace(/\s/g,'').length >= OCR_TEXT_THRESHOLD;

    if(hasRealText){
      progressCb({type:'page-text', page:p, total:numPages});
    } else {
      progressCb({type:'page-ocr-start', page:p, total:numPages});
      try{
        const viewport = page.getViewport({scale:2});
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        await page.render({canvasContext: ctx, viewport}).promise;

        const result = await Tesseract.recognize(canvas, 'eng', {
          logger: m => {
            if(m.status === 'recognizing text' && typeof m.progress === 'number'){
              progressCb({type:'page-ocr-progress', page:p, total:numPages, pct:m.progress});
            }
          }
        });
        pageText = result.data.text || '';
        ocrPagesUsed++;
        progressCb({type:'page-ocr-done', page:p, total:numPages});
      } catch(ocrErr){
        ocrFailedPages++;
        progressCb({type:'page-ocr-failed', page:p, total:numPages});
        pageText = '';
      }
    }

    fullText += pageText + '\n';
  }

  return {text: fullText, pages: numPages, ocrPagesUsed, ocrFailedPages};
}

function preprocessPdfText(rawText){
  if(!rawText) return '';
  let text = rawText;

  // 1. Insert newlines before Headers / Footers
  text = text.replace(/([^\n])\s*(Forests\s+and\s+Their\s+Management[^\n]*)/gi, '$1\n$2');
  text = text.replace(/([^\n])\s*(Week\s+\d+)/gi, '$1\n$2');
  text = text.replace(/([^\n])\s*(Page\s+\d+(?:\s+of\s+\d+)?)/gi, '$1\n$2');

  // 2. Insert newlines before Question markers like "Question 1", "Question 2", "Q1.", "Q.1"
  text = text.replace(/([^\n])\s*(Question\s*\d{1,3}[\.\:\)]?)/gi, '$1\n$2');
  text = text.replace(/([^\n])\s*(Q\d{1,3}[\.\:\)])/gi, '$1\n$2');

  // 3. Insert newlines before Answer markers
  text = text.replace(/([^\n])\s*((?:Answer|Ans|Correct\s*(?:Answer|Option))\s*[\:\-\.])/gi, '$1\n$2');

  // 4. Split lines and process option markers ONLY if line is NOT an Answer line
  const lines = text.split('\n');
  const outLines = [];

  for(let line of lines){
    const trimmed = line.trim();
    if(/^(?:Answer|Ans|Correct\s*(?:Answer|Option))[\s\:\-\.]/i.test(trimmed)){
      outLines.push(trimmed);
    } else {
      let sub = line.replace(/([^\n])\s*([•\*\-]\s*[a-d][\.\)\:]\s+)/gi, '$1\n$2');
      sub = sub.replace(/([^\n])\s+([a-d][\.\)]\s+)/gi, '$1\n$2');
      sub.split('\n').forEach(l => { if(l.trim()) outLines.push(l.trim()); });
    }
  }

  return outLines.join('\n');
}

function cleanBullets(str){
  if(!str) return '';
  return str.replace(/^[•\*\-\s]+|[•\*\-\s]+$/g, '').trim();
}

function isHeaderOrFooter(line){
  if(!line) return true;
  const l = line.trim();
  if(/^Page\s+\d+(\s+of\s+\d+)?$/i.test(l)) return true;
  if(/^(?:Forests\s+and\s+Their\s+Management|Week\s+\d+)(\s*\:?\s*Week\s*\d+)?$/i.test(l)) return true;
  return false;
}

function extractInlineAnswerFromText(str, currentOptions){
  if(!str) return null;

  // Case 1: Letter specified, e.g. "Answer: d. education", "Ans: d", "(Answer: d)"
  let m = str.match(/(?:\s+|\()?(?:Answer|Ans|Correct\s*(?:Answer|Option))[\s\:\-\.]*(?:option\s*)?\(?([A-Da-d])\)?.*$/i);
  if(m){
    const letter = m[1].toUpperCase();
    const cleanText = cleanBullets(str.substring(0, m.index));
    return { letter, cleanText };
  }

  // Case 2: Full answer text specified without letter, e.g. "Answer: education"
  m = str.match(/(?:\s+|\()?(?:Answer|Ans|Correct\s*(?:Answer|Option))[\s\:\-\.]*(.*)$/i);
  if(m){
    const cleanText = cleanBullets(str.substring(0, m.index));
    const ansVal = m[1].replace(/[\)\.\s]+$/,'').trim().toLowerCase();
    let letter = null;
    if(currentOptions){
      for(const [L, optText] of Object.entries(currentOptions)){
        const cleanOpt = optText.trim().toLowerCase();
        if(cleanOpt === ansVal || ansVal.startsWith(L.toLowerCase() + '.')){
          letter = L;
          break;
        }
      }
    }
    return { letter, cleanText };
  }

  return null;
}

// Parse questions + options + optional answer key from raw text
function parseQuestions(rawText){
  const processedText = preprocessPdfText(rawText);
  const lines = processedText.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  
  const qStart = /^(?:(?:Question|Q)\s*(\d{1,3})[\.\)\:]?|(\d{1,3})[\.\)\:]\s*)(.*)/i;
  const optStart = /^(?:[•\*\-\s]*)(?:\(|\[)?([A-Da-d])[\.\)\:\]]\s+(.*)/;
  const answerKeyHeader = /^(?:ANSWER\s*KEY|ANSWERS|SOLUTIONS|ANSWER\s*SHEET)/i;

  const rawQuestions = []; // {number, textLines:[], options:{A:'',B:'',...}, inlineAnswer: null}
  let current = null;
  let mode = 'questions'; // switches to 'answerkey' once header found
  const answerKey = {}; // number -> letter

  for(const line of lines){
    if(isHeaderOrFooter(line)) continue;
    if(answerKeyHeader.test(line)){ mode = 'answerkey'; continue; }

    if(mode === 'answerkey'){
      // lines like "1. B" or "1) B" or "1 B" or "1. B - explanation"
      const m = line.match(/^(\d{1,3})[\.\)\:]?\s*([A-Da-d])\b(.*)$/);
      if(m){
        answerKey[parseInt(m[1],10)] = m[2].toUpperCase();
      }
      continue;
    }

    const qm = line.match(qStart);
    const om = line.match(optStart);
    const ansLineMatch = line.match(/^(?:Answer|Ans|Correct\s*(?:Answer|Option))[\s\:\-\.]*(?:option\s*)?\(?([A-Da-d])\)?(?:\s*[\.\:\-\)].*|$)/i);

    if(qm && !om){
      if(current) rawQuestions.push(current);
      const qNum = parseInt(qm[1] || qm[2], 10);
      current = { number: qNum, textLines:[cleanBullets(qm[3])], options:{}, inlineAnswer: null };
    } else if(ansLineMatch && current){
      current.inlineAnswer = ansLineMatch[1].toUpperCase();
    } else if(om && current){
      const letter = om[1].toUpperCase();
      const extracted = extractInlineAnswerFromText(om[2]);
      if(extracted){
        current.options[letter] = cleanBullets(extracted.cleanText);
        if(!current.inlineAnswer && extracted.letter) current.inlineAnswer = extracted.letter;
      } else {
        current.options[letter] = cleanBullets(om[2]);
      }
    } else if(current){
      const genericAnsMatch = line.match(/^(?:Answer|Ans|Correct\s*(?:Answer|Option))[\s\:\-\.]*(.*)/i);
      if(genericAnsMatch && genericAnsMatch[1]){
        const ansVal = genericAnsMatch[1].trim().toLowerCase();
        let matchedLetter = null;
        for(const [L, optText] of Object.entries(current.options)){
          if(optText.trim().toLowerCase() === ansVal || ansVal.startsWith(L.toLowerCase() + '.')){
            matchedLetter = L;
            break;
          }
        }
        if(matchedLetter){
          current.inlineAnswer = matchedLetter;
        }
      } else {
        // continuation line: append to question text if no options started yet, else append to last option
        const optLetters = Object.keys(current.options);
        if(optLetters.length === 0){
          current.textLines.push(cleanBullets(line));
        } else {
          const last = optLetters[optLetters.length-1];
          current.options[last] += ' ' + cleanBullets(line);
        }
      }
    }
  }
  if(current) rawQuestions.push(current);

  const valid = [];
  const invalid = [];
  rawQuestions.forEach((rq, idx) => {
    // Post-process options to clean out any remaining embedded answer text
    Object.keys(rq.options).forEach(L => {
      const extracted = extractInlineAnswerFromText(rq.options[L], rq.options);
      if(extracted){
        rq.options[L] = cleanBullets(extracted.cleanText);
        if(!rq.inlineAnswer && extracted.letter){
          rq.inlineAnswer = extracted.letter;
        }
      }
    });

    const qText = cleanBullets(rq.textLines.join(' '));
    const letters = Object.keys(rq.options).sort();
    const opts = letters.map((L,i) => ({ id:'opt_'+rq.number+'_'+i, letter:L, text: cleanBullets(rq.options[L]) }));
    const validOpts = opts.filter(o => o.text.length>0);
    const ok = qText.length>0 && validOpts.length>=2;
    const qid = 'q_'+rq.number+'_'+idx;
    let correctOptionId = null;
    const ansLetter = rq.inlineAnswer || answerKey[rq.number];
    if(ansLetter){
      const match = validOpts.find(o=>o.letter===ansLetter);
      if(match) correctOptionId = match.id;
    }
    const built = {
      id: qid,
      originalNumber: rq.number,
      question: qText,
      options: validOpts.map(o=>({id:o.id, text:o.text})),
      correctOptionId,
      explanation: null,
    };
    if(ok){ valid.push(built); } else { invalid.push(built); }
  });

  return { valid, invalid };
}

// ===================== Processing flow =====================
// Appends a line to the live boot-log and updates the progress bar.
function pushLog(text, cls, pct){
  state.processingLines.push({text, cls: cls||'ok'});
  if(typeof pct === 'number') state.processingPct = pct;
  render();
}
function sleep(ms){
  return new Promise(res => setTimeout(res, state.settings.animations ? ms : Math.min(ms,15)));
}

async function startProcessing(file){
  state.error = null;
  state.pdfMeta = { filename: file.name, size: file.size, pages: null };
  state.screen = 'processing';
  state.processingLines = [];
  state.processingPct = 0;
  render();

  try{
    if(file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')){
      throw new Error('INVALID_FILE');
    }
    if(file.size > 40*1024*1024){
      throw new Error('FILE_TOO_LARGE');
    }

    pushLog('SYSTEM INITIALIZING...', 'ok', 4); await sleep(200);
    pushLog('READING PDF...', 'ok', 8); await sleep(200);

    let ocrEngineAnnounced = false;
    const progressCb = (evt) => {
      const base = 10, span = 65; // pages occupy pct range [10, 75]
      const pageFrac = (i, sub=0) => ((i-1+sub)/evt.total);
      switch(evt.type){
        case 'page-text':
          pushLog(`PAGE ${evt.page}/${evt.total}: TEXT LAYER FOUND`, 'ok', base + Math.round(pageFrac(evt.page,1)*span));
          break;
        case 'page-ocr-start':
          if(!ocrEngineAnnounced){
            pushLog('NO TEXT LAYER DETECTED — LOADING OCR ENGINE...', 'amber');
            ocrEngineAnnounced = true;
          }
          pushLog(`PAGE ${evt.page}/${evt.total}: RUNNING OCR (SCANNED PAGE)...`, 'amber', base + Math.round(pageFrac(evt.page,0)*span));
          break;
        case 'page-ocr-progress': {
          // Update the percentage smoothly without spamming the log with a new line per tick.
          state.processingPct = base + Math.round(pageFrac(evt.page, evt.pct)*span);
          render();
          break;
        }
        case 'page-ocr-done':
          pushLog(`PAGE ${evt.page}/${evt.total}: OCR COMPLETE`, 'ok', base + Math.round(pageFrac(evt.page,1)*span));
          break;
        case 'page-ocr-failed':
          pushLog(`PAGE ${evt.page}/${evt.total}: TEXT COULD NOT BE RELIABLY RECOGNIZED`, 'amber', base + Math.round(pageFrac(evt.page,1)*span));
          break;
      }
    };

    const {text, pages, ocrPagesUsed, ocrFailedPages} = await extractTextFromPdf(file, progressCb);
    state.pdfMeta.pages = pages;
    state.rawText = text;
    if(!text || text.trim().length < 5){
      throw new Error('EMPTY_PDF');
    }
    if(ocrFailedPages > 0 && ocrFailedPages === pages){
      throw new Error('OCR_FAILED');
    }

    pushLog('DETECTING QUESTIONS...', 'ok', 82); await sleep(180);
    pushLog('DETECTING ANSWER OPTIONS...', 'ok', 90); await sleep(180);
    const { valid, invalid } = parseQuestions(text);

    pushLog('VALIDATING QUESTION STRUCTURE...', 'ok', 96); await sleep(180);
    if(valid.length === 0){
      throw new Error('NO_QUESTIONS');
    }
    state.questions = valid;
    state.invalidQuestions = invalid;
    state.ocrPagesUsed = ocrPagesUsed;

    pushLog('QUIZ READY.', 'amber', 100); await sleep(220);
    state.screen = 'config';
    render();
  } catch(err){
    let msg = 'Something went wrong while processing the PDF. Please try again.';
    if(err.message === 'INVALID_FILE') msg = 'Please upload a valid PDF.';
    else if(err.message === 'FILE_TOO_LARGE') msg = 'This file is larger than the 40 MB limit. Please upload a smaller PDF.';
    else if(err.message === 'EMPTY_PDF') msg = 'No readable content was found in this PDF.';
    else if(err.message === 'OCR_FAILED') msg = 'Text could not be reliably recognized from this document.';
    else if(err.message === 'NO_QUESTIONS') msg = 'No quiz questions could be detected in this PDF.';
    state.error = msg;
    state.screen = 'home';
    render();
  }
}

// ===================== Quiz lifecycle =====================
function buildQuizOrder(){
  let qOrder = state.questions.map(q=>q.id);
  if(state.settings.shuffleQuestions) qOrder = fisherYates(qOrder);

  const shuffledOptionsByQ = {};
  state.questions.forEach(q => {
    shuffledOptionsByQ[q.id] = state.settings.shuffleOptions ? fisherYates(q.options) : q.options.slice();
  });

  return { qOrder, shuffledOptionsByQ };
}

function startQuiz(){
  const { qOrder, shuffledOptionsByQ } = buildQuizOrder();
  state.quiz = {
    order: qOrder,
    displayOptions: shuffledOptionsByQ,
    answers: {},
    marked: new Set(),
    current: 0,
    timeRemaining: state.settings.timerEnabled ? state.settings.timerMinutes*60 : null,
    startTs: Date.now(),
    endTs: null,
    finished: false,
    timerHandle: null,
  };
  state.screen = 'quiz';
  render();
  if(state.settings.timerEnabled) tickTimer();
}

function tickTimer(){
  if(!state.quiz || state.quiz.finished) return;
  state.quiz.timerHandle = setTimeout(() => {
    if(!state.quiz || state.quiz.finished) return;
    state.quiz.timeRemaining -= 1;
    if(state.quiz.timeRemaining <= 0){
      state.quiz.timeRemaining = 0;
      render();
      submitQuiz(true);
      return;
    }
    render();
    tickTimer();
  }, 1000);
}

function stopTimer(){
  if(state.quiz && state.quiz.timerHandle){ clearTimeout(state.quiz.timerHandle); state.quiz.timerHandle=null; }
}

function currentQuestion(){
  const q = state.quiz;
  const qid = q.order[q.current];
  return state.questions.find(x=>x.id===qid);
}

function selectAnswer(optionId){
  const q = state.quiz;
  const qid = q.order[q.current];
  q.answers[qid] = optionId;
  render();
}

function toggleMark(){
  const q = state.quiz;
  const qid = q.order[q.current];
  if(q.marked.has(qid)) q.marked.delete(qid); else q.marked.add(qid);
  render();
}

function goTo(idx){
  state.quiz.current = Math.max(0, Math.min(state.quiz.order.length-1, idx));
  render();
}

function submitQuiz(auto){
  stopTimer();
  state.quiz.finished = true;
  state.quiz.endTs = Date.now();
  state.quiz.timedOut = !!auto;
  state.modal = null;
  state.screen = 'result';
  render();
}

function computeScore(){
  const q = state.quiz;
  let correct=0, incorrect=0, unanswered=0;
  q.order.forEach(qid => {
    const question = state.questions.find(x=>x.id===qid);
    const ans = q.answers[qid];
    if(!ans) { unanswered++; return; }
    if(question.correctOptionId && ans === question.correctOptionId) correct++;
    else incorrect++;
  });
  const total = q.order.length;
  const pct = total>0 ? Math.round((correct/total)*100) : 0;
  const timeTaken = q.endTs ? Math.round((q.endTs-q.startTs)/1000) : 0;
  return {correct, incorrect, unanswered, total, pct, timeTaken};
}

function restartQuiz(newShuffleQ, newShuffleO){
  state.settings.shuffleQuestions = newShuffleQ;
  state.settings.shuffleOptions = newShuffleO;
  state.modal = null;
  startQuiz();
}

function newPdf(){
  state.screen = 'home';
  state.pdfMeta = null;
  state.rawText = '';
  state.questions = [];
  state.invalidQuestions = [];
  state.quiz = null;
  state.error = null;
  state.modal = null;
  state.ocrPagesUsed = 0;
  state.processingLines = [];
  render();
}

// ===================== Rendering =====================
const App = {
  render(){
    const root = document.getElementById('app');
    root.innerHTML = this.screenHtml() + (state.modal ? this.modalHtml() : '');
    this.afterRender();
    document.getElementById('statusLeft').textContent =
      state.screen === 'quiz' ? `IN PROGRESS · Q${state.quiz.current+1}/${state.quiz.order.length}` :
      'PRIVACY-FIRST · NO ACCOUNT · NO DATABASE';
  },

  screenHtml(){
    switch(state.screen){
      case 'home': return this.homeHtml();
      case 'processing': return this.processingHtml();
      case 'config': return this.configHtml();
      case 'quiz': return this.quizHtml();
      case 'result': return this.resultHtml();
      case 'review': return this.reviewHtml();
      default: return '';
    }
  },

  homeHtml(){
    return `
      <div class="brand">QUIZMORPH</div>
      <div class="subtitle">Turn any quiz PDF into an interactive quiz.</div>
      <div class="supporting">Upload your PDF. Answer every question. Get your result. Restart anytime.</div>
      <div class="home-badges">
        <span>NO ACCOUNT</span><span>NO DATABASE</span><span>NO SAVED HISTORY</span>
      </div>
      <div class="upload-zone ${state.dragOver?'drag':''}" id="uploadZone" tabindex="0" role="button" aria-label="Upload quiz PDF">
        <div class="icon">▣</div>
        <div class="primary-text">DROP QUIZ PDF HERE</div>
        <div class="or">— OR —</div>
        <button class="btn btn-primary" id="selectPdfBtn" type="button">[ SELECT PDF ]</button>
        <input type="file" accept="application/pdf,.pdf" id="fileInput" style="display:none" />
      </div>
      ${state.error ? `<div class="error-box">⚠ ${esc(state.error)}<div class="btn-row" style="margin-top:10px;"><button class="btn btn-ghost" id="tryAgainBtn">[ TRY AGAIN ]</button></div></div>` : ''}
      <div class="footer-note" style="margin-top:22px;">Supports text-based and scanned PDFs (auto OCR) · Max 40MB · Scanned pages take longer to process</div>
    `;
  },

  processingHtml(){
    const meta = state.pdfMeta;
    const lines = state.processingLines;
    return `
      <div class="eyebrow">PDF PROCESSING</div>
      <h2 class="section-title">Analyzing ${esc(meta?.filename||'document')}</h2>
      <div class="boot-log" id="bootLog">
        ${lines.map((l,i)=>`<div class="line ${l.cls}" style="animation-delay:${Math.min(i,6)*0.04}s">${l.cls==='amber' && i===lines.length-1 ? '&gt; ':'✓ '}${esc(l.text)}</div>`).join('')}
      </div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${state.processingPct}%"></div></div>
      <div class="progress-pct">${state.processingPct}%</div>
    `;
  },

  configHtml(){
    const total = state.questions.length;
    const invalid = state.invalidQuestions.length;
    const s = state.settings;
    return `
      <div class="eyebrow">QUIZ CONFIGURATION</div>
      <h2 class="section-title">${esc(state.pdfMeta.filename)}</h2>
      <div class="panel">
        <div class="row"><div><div class="label">Questions detected</div></div><div class="label">${total+invalid}</div></div>
        <div class="row"><div><div class="label">Questions ready</div></div><div class="label" style="color:var(--green)">${total}</div></div>
        ${state.ocrPagesUsed>0 ? `<div class="row"><div><div class="label">Pages processed via OCR</div><div class="desc">These pages had no selectable text layer, so text was recognized from the scanned image.</div></div><div class="label">${state.ocrPagesUsed} / ${state.pdfMeta.pages}</div></div>` : ''}
        ${invalid>0 ? `<div class="row"><div><div class="label" style="color:var(--orange)">${invalid} question(s) require review</div><div class="desc">These couldn't be fully parsed and are excluded from the quiz.</div></div><button class="btn btn-ghost" id="reviewInvalidBtn">[ REVIEW ]</button></div>` : ''}
      </div>

      <div class="panel">
        <div class="row">
          <div><div class="label">SHUFFLE QUESTIONS</div><div class="desc">Randomize question order. Content stays unchanged.</div></div>
          <div class="toggle ${s.shuffleQuestions?'on':''}" id="toggleShuffleQ" role="switch" aria-checked="${s.shuffleQuestions}" tabindex="0"><div class="knob"></div></div>
        </div>
        <div class="row">
          <div><div class="label">SHUFFLE OPTIONS</div><div class="desc">Randomize answer order. Correctness is preserved.</div></div>
          <div class="toggle ${s.shuffleOptions?'on':''}" id="toggleShuffleO" role="switch" aria-checked="${s.shuffleOptions}" tabindex="0"><div class="knob"></div></div>
        </div>
        <div class="row">
          <div><div class="label">TIMER</div><div class="desc">${s.timerEnabled? s.timerMinutes+' minute limit, auto-submits at zero.' : 'Unlimited time.'}</div></div>
          <div class="toggle ${s.timerEnabled?'on':''}" id="toggleTimer" role="switch" aria-checked="${s.timerEnabled}" tabindex="0"><div class="knob"></div></div>
        </div>
        ${s.timerEnabled ? `
        <div class="row">
          <div class="label">Duration</div>
          <div class="seg" id="timerPresets">
            ${[10,20,30,60].map(m=>`<button data-min="${m}" class="${s.timerMinutes===m?'active':''}">${m}m</button>`).join('')}
            <input type="number" id="customTimer" min="1" max="300" value="${[10,20,30,60].includes(s.timerMinutes)?'':s.timerMinutes}" placeholder="custom" />
          </div>
        </div>` : ''}
      </div>

      <div class="btn-row">
        <button class="btn btn-ghost" id="backToUploadBtn">[ NEW PDF ]</button>
        <button class="btn btn-primary" id="startQuizBtn">[ START QUIZ ]</button>
      </div>
    `;
  },

  quizHtml(){
    const q = state.quiz;
    const question = currentQuestion();
    const opts = q.displayOptions[question.id];
    const selected = q.answers[question.id];
    const answeredCount = Object.keys(q.answers).length;
    const total = q.order.length;
    const pct = Math.round(((q.current+1)/total)*100);
    const marked = q.marked.has(question.id);
    const timerLow = q.timeRemaining !== null && q.timeRemaining <= 60;

    return `
      <div class="quiz-top">
        <div class="qnum">QUESTION ${q.current+1} / ${total}</div>
        ${q.timeRemaining !== null ? `<div class="timer ${timerLow?'warn':''}">TIME REMAINING ${fmtTime(q.timeRemaining)}</div>` : ''}
      </div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>

      <div class="qcard">
        <div class="qtext">${esc(question.question)}</div>
        <div class="options" role="radiogroup" aria-label="Answer options">
          ${opts.map((o,i)=>`
            <button class="option ${selected===o.id?'selected':''}" data-optid="${o.id}" role="radio" aria-checked="${selected===o.id}">
              <span class="tag">[${optLetter(i)}]</span><span>${esc(o.text)}</span>
            </button>`).join('')}
        </div>
      </div>

      <div class="nav-buttons">
        <button class="btn btn-ghost" id="prevBtn" ${q.current===0?'disabled':''}>[ PREVIOUS ]</button>
        <button class="btn btn-ghost" id="markBtn">${marked?'[ UNMARK REVIEW ]':'[ MARK FOR REVIEW ]'}</button>
        ${q.current === total-1
          ? `<button class="btn btn-primary" id="submitBtn">[ SUBMIT QUIZ ]</button>`
          : `<button class="btn btn-primary" id="nextBtn">[ NEXT ]</button>`}
      </div>

      <div class="navigator" role="group" aria-label="Question navigator">
        ${q.order.map((qid,i)=>{
          const cls = [i===q.current?'current':'', q.answers[qid]?'answered':'', q.marked.has(qid)?'review':''].join(' ');
          return `<button class="${cls}" data-goto="${i}" aria-label="Question ${i+1}">${String(i+1).padStart(2,'0')}</button>`;
        }).join('')}
      </div>
      <div class="legend">
        <span class="l-ans">answered</span><span class="l-rev">marked</span><span class="l-un">unanswered</span>
      </div>
      <div class="footer-note">Answered: ${answeredCount} · Unanswered: ${total-answeredCount} · Marked: ${q.marked.size}</div>
    `;
  },

  resultHtml(){
    const sc = computeScore();
    return `
      <div class="eyebrow" style="text-align:center;">QUIZ COMPLETE</div>
      <div class="result-hero">
        <div class="result-pct">${sc.pct}%</div>
        <div class="result-frac">${sc.correct} / ${sc.total} CORRECT ${state.quiz.timedOut ? ' · TIME&#39;S UP — AUTO-SUBMITTED' : ''}</div>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="num green">${sc.correct}</div><div class="lbl">CORRECT</div></div>
        <div class="stat"><div class="num red">${sc.incorrect}</div><div class="lbl">INCORRECT</div></div>
        <div class="stat"><div class="num dim">${sc.unanswered}</div><div class="lbl">UNANSWERED</div></div>
        <div class="stat"><div class="num">${fmtTime(sc.timeTaken)}</div><div class="lbl">TIME TAKEN</div></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-ghost" id="reviewAnswersBtn">[ REVIEW ANSWERS ]</button>
        <button class="btn btn-ghost" id="restartQuizBtn">[ RESTART QUIZ ]</button>
        <button class="btn btn-primary" id="newPdfBtn">[ NEW PDF ]</button>
      </div>
    `;
  },

  reviewHtml(){
    const q = state.quiz;
    const filter = state.reviewFilter;
    const rows = q.order.map(qid => {
      const question = state.questions.find(x=>x.id===qid);
      const opts = q.displayOptions[qid];
      const ansId = q.answers[qid];
      const ansOpt = opts.find(o=>o.id===ansId);
      const correctOpt = opts.find(o=>o.id===question.correctOptionId);
      let status = 'blank', label = 'UNANSWERED';
      if(ansId){
        if(question.correctOptionId){
          status = ansId===question.correctOptionId ? 'correct':'incorrect';
          label = status==='correct' ? '✓ CORRECT' : '✗ INCORRECT';
        } else {
          status='blank'; label='NO ANSWER KEY';
        }
      }
      return {question, opts, ansOpt, correctOpt, status, label};
    }).filter(r => filter==='wrong' ? r.status==='incorrect' || r.status==='blank' : true);

    return `
      <div class="eyebrow">REVIEW ANSWERS</div>
      <div class="btn-row" style="justify-content:flex-start; margin-bottom:16px;">
        <button class="seg-btn btn ${filter==='all'?'btn-primary':'btn-ghost'}" id="filterAll" style="padding:8px 14px;font-size:11.5px;">ALL</button>
        <button class="seg-btn btn ${filter==='wrong'?'btn-primary':'btn-ghost'}" id="filterWrong" style="padding:8px 14px;font-size:11.5px;">[ SHOW ONLY WRONG ]</button>
      </div>
      ${rows.length===0 ? `<div class="supporting">Nothing to show for this filter.</div>` : rows.map(r=>`
        <div class="review-card">
          <div class="eyebrow">QUESTION ${r.question.originalNumber}</div>
          <div class="qtext" style="font-size:13.5px;">${esc(r.question.question)}</div>
          <div style="margin-top:10px; font-size:12.5px;">
            <div class="k" style="color:var(--fg-dim)">Your answer:</div>
            <div>${r.ansOpt ? esc(r.ansOpt.text) : '—'}</div>
            ${r.status==='incorrect' && r.correctOpt ? `<div class="k" style="color:var(--fg-dim); margin-top:6px;">Correct answer:</div><div>${esc(r.correctOpt.text)}</div>` : ''}
          </div>
          <div class="review-status ${r.status}">${r.label}</div>
        </div>
      `).join('')}
      <div class="btn-row" style="margin-top:10px;">
        <button class="btn btn-ghost" id="backToResultBtn">[ BACK TO RESULT ]</button>
      </div>
    `;
  },

  modalHtml(){
    const m = state.modal;
    if(m.type === 'submitConfirm'){
      const q = state.quiz;
      const answered = Object.keys(q.answers).length;
      const total = q.order.length;
      return `<div class="modal-backdrop" id="modalBackdrop"><div class="modal">
        <h3>SUBMIT QUIZ?</h3>
        <p>Answered: ${answered} &nbsp;·&nbsp; Unanswered: ${total-answered} &nbsp;·&nbsp; Marked for review: ${q.marked.size}<br/><br/>Are you sure you want to submit?</p>
        <div class="btn-row">
          <button class="btn btn-ghost" id="modalCancel">[ CANCEL ]</button>
          <button class="btn btn-primary" id="modalConfirmSubmit">[ SUBMIT QUIZ ]</button>
        </div>
      </div></div>`;
    }
    if(m.type === 'restartConfirm'){
      return `<div class="modal-backdrop" id="modalBackdrop"><div class="modal">
        <h3>RESTART QUIZ?</h3>
        <p>Your current answers will be cleared.</p>
        <div class="panel" style="margin-bottom:14px;">
          <div class="row"><div class="label">Question order</div>
            <div class="seg">
              <button data-rq="0" class="${!state.settings.shuffleQuestions?'active':''}">Same</button>
              <button data-rq="1" class="${state.settings.shuffleQuestions?'active':''}">Shuffle</button>
            </div>
          </div>
          <div class="row"><div class="label">Answer options</div>
            <div class="seg">
              <button data-ro="0" class="${!state.settings.shuffleOptions?'active':''}">Same</button>
              <button data-ro="1" class="${state.settings.shuffleOptions?'active':''}">Shuffle</button>
            </div>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost" id="modalCancel">[ CANCEL ]</button>
          <button class="btn btn-primary" id="modalConfirmRestart">[ START AGAIN ]</button>
        </div>
      </div></div>`;
    }
    if(m.type === 'settings'){
      const s = state.settings;
      return `<div class="modal-backdrop" id="modalBackdrop"><div class="modal">
        <h3>SETTINGS</h3>
        <div class="row"><div class="label">CRT Effects</div><div class="toggle ${s.crt?'on':''}" id="toggleCrt"><div class="knob"></div></div></div>
        <div class="row"><div class="label">Animations</div><div class="toggle ${s.animations?'on':''}" id="toggleAnim"><div class="knob"></div></div></div>
        <div class="row"><div class="label">Sound</div><div class="toggle ${s.sound?'on':''}" id="toggleSound"><div class="knob"></div></div></div>
        <div class="row"><div class="label">Reduced motion</div><div class="toggle ${s.reducedMotion?'on':''}" id="toggleReduced"><div class="knob"></div></div></div>
        <div class="btn-row" style="margin-top:16px;"><button class="btn btn-primary" id="modalClose">[ CLOSE ]</button></div>
      </div></div>`;
    }
    if(m.type === 'invalidList'){
      return `<div class="modal-backdrop" id="modalBackdrop"><div class="modal" style="max-width:480px;">
        <h3>QUESTIONS REQUIRING REVIEW</h3>
        <p>${state.invalidQuestions.length} question(s) could not be fully parsed and are excluded from the quiz.</p>
        <div style="max-height:260px; overflow:auto;">
          ${state.invalidQuestions.map(q=>`<div class="warn-item"><span>QUESTION ${q.originalNumber}</span><span style="color:var(--orange)">⚠ incomplete</span></div>`).join('')}
        </div>
        <div class="btn-row" style="margin-top:16px;"><button class="btn btn-primary" id="modalClose">[ CLOSE ]</button></div>
      </div></div>`;
    }
    return '';
  },

  afterRender(){
    applyGlobalSettingClasses();
    const bootLog = document.getElementById('bootLog');
    if(bootLog) bootLog.scrollTop = bootLog.scrollHeight;
    // Home
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    if(uploadZone){
      uploadZone.addEventListener('click', () => fileInput.click());
      uploadZone.addEventListener('keydown', e => { if(e.key==='Enter'||e.key===' ') fileInput.click(); });
      uploadZone.addEventListener('dragover', e => { e.preventDefault(); state.dragOver=true; uploadZone.classList.add('drag'); });
      uploadZone.addEventListener('dragleave', () => { state.dragOver=false; uploadZone.classList.remove('drag'); });
      uploadZone.addEventListener('drop', e => {
        e.preventDefault(); state.dragOver=false;
        const f = e.dataTransfer.files[0];
        if(f) startProcessing(f);
      });
    }
    if(fileInput) fileInput.addEventListener('change', e => { if(e.target.files[0]) startProcessing(e.target.files[0]); });
    const selBtn = document.getElementById('selectPdfBtn');
    if(selBtn) selBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
    const tryAgain = document.getElementById('tryAgainBtn');
    if(tryAgain) tryAgain.addEventListener('click', () => { state.error=null; render(); });

    // Config
    const tQ = document.getElementById('toggleShuffleQ');
    if(tQ) tQ.addEventListener('click', () => { state.settings.shuffleQuestions=!state.settings.shuffleQuestions; render(); });
    const tO = document.getElementById('toggleShuffleO');
    if(tO) tO.addEventListener('click', () => { state.settings.shuffleOptions=!state.settings.shuffleOptions; render(); });
    const tT = document.getElementById('toggleTimer');
    if(tT) tT.addEventListener('click', () => { state.settings.timerEnabled=!state.settings.timerEnabled; render(); });
    const presets = document.getElementById('timerPresets');
    if(presets) presets.querySelectorAll('button[data-min]').forEach(b=>{
      b.addEventListener('click', () => { state.settings.timerMinutes = parseInt(b.dataset.min,10); render(); });
    });
    const customTimer = document.getElementById('customTimer');
    if(customTimer) customTimer.addEventListener('change', e => {
      const v = parseInt(e.target.value,10);
      if(v>0) { state.settings.timerMinutes = v; render(); }
    });
    const reviewInvalid = document.getElementById('reviewInvalidBtn');
    if(reviewInvalid) reviewInvalid.addEventListener('click', () => { state.modal={type:'invalidList'}; render(); });
    const backUp = document.getElementById('backToUploadBtn');
    if(backUp) backUp.addEventListener('click', newPdf);
    const startBtn = document.getElementById('startQuizBtn');
    if(startBtn) startBtn.addEventListener('click', startQuiz);

    // Quiz
    document.querySelectorAll('.option').forEach(el=>{
      el.addEventListener('click', () => selectAnswer(el.dataset.optid));
    });
    const prevBtn = document.getElementById('prevBtn');
    if(prevBtn) prevBtn.addEventListener('click', () => goTo(state.quiz.current-1));
    const nextBtn = document.getElementById('nextBtn');
    if(nextBtn) nextBtn.addEventListener('click', () => goTo(state.quiz.current+1));
    const markBtn = document.getElementById('markBtn');
    if(markBtn) markBtn.addEventListener('click', toggleMark);
    const submitBtn = document.getElementById('submitBtn');
    if(submitBtn) submitBtn.addEventListener('click', () => { state.modal={type:'submitConfirm'}; render(); });
    document.querySelectorAll('.navigator button[data-goto]').forEach(el=>{
      el.addEventListener('click', () => goTo(parseInt(el.dataset.goto,10)));
    });

    // Result
    const reviewBtn = document.getElementById('reviewAnswersBtn');
    if(reviewBtn) reviewBtn.addEventListener('click', () => { state.screen='review'; state.reviewFilter='all'; render(); });
    const restartBtn = document.getElementById('restartQuizBtn');
    if(restartBtn) restartBtn.addEventListener('click', () => { state.modal={type:'restartConfirm'}; render(); });
    const newPdfBtn = document.getElementById('newPdfBtn');
    if(newPdfBtn) newPdfBtn.addEventListener('click', newPdf);

    // Review
    const filterAll = document.getElementById('filterAll');
    if(filterAll) filterAll.addEventListener('click', () => { state.reviewFilter='all'; render(); });
    const filterWrong = document.getElementById('filterWrong');
    if(filterWrong) filterWrong.addEventListener('click', () => { state.reviewFilter='wrong'; render(); });
    const backResult = document.getElementById('backToResultBtn');
    if(backResult) backResult.addEventListener('click', () => { state.screen='result'; render(); });

    // Modal
    const backdrop = document.getElementById('modalBackdrop');
    if(backdrop) backdrop.addEventListener('click', e => { if(e.target===backdrop){} });
    const modalCancel = document.getElementById('modalCancel');
    if(modalCancel) modalCancel.addEventListener('click', () => { state.modal=null; render(); });
    const modalClose = document.getElementById('modalClose');
    if(modalClose) modalClose.addEventListener('click', () => { state.modal=null; render(); });
    const modalConfirmSubmit = document.getElementById('modalConfirmSubmit');
    if(modalConfirmSubmit) modalConfirmSubmit.addEventListener('click', () => submitQuiz(false));
    let pendingRq = state.settings.shuffleQuestions, pendingRo = state.settings.shuffleOptions;
    document.querySelectorAll('button[data-rq]').forEach(b=>b.addEventListener('click', ()=>{
      pendingRq = b.dataset.rq==='1';
      document.querySelectorAll('button[data-rq]').forEach(x=>x.classList.toggle('active', x===b));
    }));
    document.querySelectorAll('button[data-ro]').forEach(b=>b.addEventListener('click', ()=>{
      pendingRo = b.dataset.ro==='1';
      document.querySelectorAll('button[data-ro]').forEach(x=>x.classList.toggle('active', x===b));
    }));
    const modalConfirmRestart = document.getElementById('modalConfirmRestart');
    if(modalConfirmRestart) modalConfirmRestart.addEventListener('click', () => restartQuiz(pendingRq, pendingRo));

    // Settings toggles
    const tCrt = document.getElementById('toggleCrt');
    if(tCrt) tCrt.addEventListener('click', () => { state.settings.crt=!state.settings.crt; render(); });
    const tAnim = document.getElementById('toggleAnim');
    if(tAnim) tAnim.addEventListener('click', () => { state.settings.animations=!state.settings.animations; render(); });
    const tSound = document.getElementById('toggleSound');
    if(tSound) tSound.addEventListener('click', () => { state.settings.sound=!state.settings.sound; render(); });
    const tReduced = document.getElementById('toggleReduced');
    if(tReduced) tReduced.addEventListener('click', () => { state.settings.reducedMotion=!state.settings.reducedMotion; render(); });
  }
};

function applyGlobalSettingClasses(){
  const monitor = document.getElementById('monitor');
  if(monitor){
    document.documentElement.style.setProperty('--scan-opacity', state.settings.crt ? '0.05' : '0');
    document.body.classList.toggle('reduced-motion', state.settings.reducedMotion);
    monitor.classList.toggle('crt-off', !state.settings.crt);
  }
}

document.getElementById('settingsBtn').addEventListener('click', () => { state.modal = {type:'settings'}; render(); });

// Keyboard shortcuts during quiz
document.addEventListener('keydown', e => {
  if(state.screen !== 'quiz' || state.modal) return;
  if(e.key === 'ArrowRight') { const nb=document.getElementById('nextBtn'); if(nb) nb.click(); }
  if(e.key === 'ArrowLeft') { const pb=document.getElementById('prevBtn'); if(pb) pb.click(); }
  if(['1','2','3','4'].includes(e.key)){
    const idx = parseInt(e.key,10)-1;
    const opts = document.querySelectorAll('.option');
    if(opts[idx]) opts[idx].click();
  }
});

render();
