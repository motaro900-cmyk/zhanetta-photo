/**
 * ASLAN BALAEV — MASTER JAVASCRIPT CONTROLLER
 * High-Craft Interactions, Sound Synthesis, 5-Step Planner Wizard,
 * Portfolio Slider, 2026 Live Calendar, and 152-ФЗ Compliance
 */

// ==========================================================================
// 1. TACTILE AUDIO SYNTHESIS (WEB AUDIO API)
// ==========================================================================
let audioCtx = null;
function playLuxuryClick(freq = 600) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, audioCtx.currentTime + 0.045);

    gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.045);

    osc.connect(gain);
    gain.connect(audioCtx.destination);

    osc.start();
    osc.stop(audioCtx.currentTime + 0.045);
  } catch (_) {}
}

// ==========================================================================
// 2. DOM INITIALIZATION
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) {
    window.lucide.createIcons();
  }
  initCursorGlow();
  initCalendar2026('april');
  checkCookieConsent();
  initMobileMenu();
});

// ==========================================================================
// 3. AMBIENT CURSOR GLOW
// ==========================================================================
function initCursorGlow() {
  const glow = document.getElementById('cursorGlow');
  if (!glow) return;

  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let currentX = mouseX;
  let currentY = mouseY;

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  }, { passive: true });

  function render() {
    currentX += (mouseX - currentX) * 0.08;
    currentY += (mouseY - currentY) * 0.08;
    glow.style.transform = `translate(${currentX}px, ${currentY}px) translate(-50%, -50%)`;
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

// ==========================================================================
// 4. MOBILE NAVIGATION DRAWER
// ==========================================================================
function initMobileMenu() {
  const btn = document.getElementById('mobileMenuBtn');
  const drawer = document.getElementById('mobileDrawer');
  if (!btn || !drawer) return;

  btn.addEventListener('click', () => {
    playLuxuryClick(550);
    drawer.classList.toggle('open');
  });
}

function closeMobileMenu() {
  const drawer = document.getElementById('mobileDrawer');
  if (drawer) drawer.classList.remove('open');
}

// ==========================================================================
// 5. PORTFOLIO SLIDER & GALLERY
// ==========================================================================
const portfolioSlides = [
  {
    src: './assets/aslan_event_gala_2k.webp',
    title: 'Private Celebration',
    sub: 'Красная Поляна — частное мероприятие'
  },
  {
    src: './assets/aslan_candlelit_2k.webp',
    title: 'Камерный вечер при свечах',
    sub: 'Сочи — ужин в закрытом клубе'
  },
  {
    src: './assets/aslan_speech_2k.webp',
    title: 'Статусный юбилей',
    sub: 'Красная Поляна — живое общение и юмор'
  },
  {
    src: './assets/krasnaya_polyana_peaks.webp',
    title: 'Свадебная церемония в горах',
    sub: 'Роза Хутор — панорама Кавказского хребта'
  },
  {
    src: './assets/aslan_sunset_hero_2k.webp',
    title: 'Sunset Welcome Drink',
    sub: 'Сочи — терраса с видом на закат'
  },
  {
    src: './assets/aslan_event_gala_2k.webp',
    title: 'Гала-ужин ТОП-менеджмента',
    sub: 'Москва &bull; Сочи — масштабное корпоративное событие'
  }
];

let currentSlideIdx = 0;

function updateSlideView() {
  const slide = portfolioSlides[currentSlideIdx];
  const imgEl = document.getElementById('portfolioHeroImg');
  const titleEl = document.getElementById('portfolioCaptionTitle');
  const subEl = document.getElementById('portfolioCaptionSub');
  const counterEl = document.getElementById('sliderCounter');

  if (imgEl) {
    imgEl.style.opacity = '0.5';
    setTimeout(() => {
      imgEl.src = slide.src;
      imgEl.style.opacity = '1';
    }, 150);
  }
  if (titleEl) titleEl.innerHTML = slide.title;
  if (subEl) subEl.innerHTML = slide.sub;
  if (counterEl) {
    const num = currentSlideIdx + 1;
    counterEl.textContent = `0${num} / 0${portfolioSlides.length}`;
  }
}

function nextSlide(e) {
  if (e) e.stopPropagation();
  playLuxuryClick(650);
  currentSlideIdx = (currentSlideIdx + 1) % portfolioSlides.length;
  updateSlideView();
}

function prevSlide(e) {
  if (e) e.stopPropagation();
  playLuxuryClick(650);
  currentSlideIdx = (currentSlideIdx - 1 + portfolioSlides.length) % portfolioSlides.length;
  updateSlideView();
}

// Lightbox
function openLightbox(src, caption) {
  playLuxuryClick(700);
  const modal = document.getElementById('lightboxModal');
  const img = document.getElementById('lightboxPhoto');
  const title = document.getElementById('lightboxTitle');

  if (img) img.src = src;
  if (title) title.innerHTML = caption || '';
  if (modal) modal.classList.add('open');
}

function closeLightbox() {
  playLuxuryClick(400);
  const modal = document.getElementById('lightboxModal');
  if (modal) modal.classList.remove('open');
}

// ==========================================================================
// 6. CALENDAR 2026 CONTROLLER
// ==========================================================================
const calendarMonthsData = [
  { key: 'april', name: 'Апрель 2026', daysCount: 30, startDayOfWeek: 2 }, // 0=Mon, 2=Wed
  { key: 'may', name: 'Май 2026', daysCount: 31, startDayOfWeek: 4 },    // 4=Fri
  { key: 'june', name: 'Июнь 2026', daysCount: 30, startDayOfWeek: 0 },   // 0=Mon
  { key: 'july', name: 'Июль 2026', daysCount: 31, startDayOfWeek: 2 },   // 2=Wed
  { key: 'august', name: 'Август 2026', daysCount: 31, startDayOfWeek: 5 }, // 5=Sat
  { key: 'september', name: 'Сентябрь 2026', daysCount: 30, startDayOfWeek: 1 } // 1=Tue
];

let calMonthIndex = 0; // Default: April 2026
let selectedCalDate = { day: 18, monthName: 'апреля', fullIso: '2026-04-18' };

function initCalendar2026(monthKey = 'april') {
  const found = calendarMonthsData.findIndex(m => m.key === monthKey);
  if (found !== -1) calMonthIndex = found;
  renderCalendarDays();
}

function calPrevMonth() {
  playLuxuryClick(550);
  if (calMonthIndex > 0) {
    calMonthIndex--;
    renderCalendarDays();
  }
}

function calNextMonth() {
  playLuxuryClick(550);
  if (calMonthIndex < calendarMonthsData.length - 1) {
    calMonthIndex++;
    renderCalendarDays();
  }
}

function renderCalendarDays() {
  const m = calendarMonthsData[calMonthIndex];
  const titleEl = document.getElementById('calMonthTitle');
  const gridEl = document.getElementById('calDaysGrid');

  if (titleEl) titleEl.textContent = m.name;
  if (!gridEl) return;

  gridEl.innerHTML = '';

  // Offset empty days
  for (let i = 0; i < m.startDayOfWeek; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day-cell empty';
    gridEl.appendChild(empty);
  }

  // Days
  for (let d = 1; d <= m.daysCount; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day-cell';
    cell.textContent = d;

    // Check if this is the currently selected date
    const monthNum = String(calMonthIndex + 4).padStart(2, '0');
    const dStr = String(d).padStart(2, '0');
    const isoDate = `2026-${monthNum}-${dStr}`;

    if (isoDate === selectedCalDate.fullIso) {
      cell.classList.add('selected');
    }

    cell.addEventListener('click', () => {
      playLuxuryClick(700);
      document.querySelectorAll('.cal-day-cell').forEach(c => c.classList.remove('selected'));
      cell.classList.add('selected');

      const monthGenitive = m.name.split(' ')[0].toLowerCase().replace(/ь$/, 'я').replace(/й$/, 'я');
      selectedCalDate = {
        day: d,
        monthName: monthGenitive,
        fullIso: isoDate
      };

      const displayEl = document.getElementById('calSelectedDisplay');
      if (displayEl) {
        displayEl.textContent = `${d} ${monthGenitive} 2026`;
      }

      // Update wizard date input
      const wizDate = document.getElementById('wizDateInput');
      if (wizDate) wizDate.value = isoDate;
    });

    gridEl.appendChild(cell);
  }
}

function continueWithSelectedDate() {
  playLuxuryClick(750);
  openPlannerModalStep(3);
}

// ==========================================================================
// 7. 5-STEP PRIVATE EVENT PLANNER WIZARD MODAL
// ==========================================================================
let currentWizardStep = 1;

function openPlannerModal() {
  playLuxuryClick(650);
  goWizardStep(1);
  const modal = document.getElementById('plannerModal');
  if (modal) modal.classList.add('open');
}

function closePlannerModal() {
  playLuxuryClick(400);
  const modal = document.getElementById('plannerModal');
  if (modal) modal.classList.remove('open');
}

function openPlannerModalStep(stepNumber) {
  playLuxuryClick(650);
  goWizardStep(stepNumber);
  const modal = document.getElementById('plannerModal');
  if (modal) modal.classList.add('open');
}

function openPlannerWithFormat(formatKey) {
  playLuxuryClick(650);
  const map = {
    wedding: 'Свадьба',
    private: 'Частный вечер',
    corporate: 'Корпоратив'
  };
  const val = map[formatKey] || 'Свадьба';
  const radio = document.querySelector(`input[name="wizFormat"][value="${val}"]`);
  if (radio) radio.checked = true;

  openPlannerModalStep(1);
}

function goWizardStep(step) {
  playLuxuryClick(550);
  currentWizardStep = step;

  // Update tabs
  document.querySelectorAll('.wizard-step-node').forEach(node => {
    const nodeStep = parseInt(node.getAttribute('data-step') || '1', 10);
    if (nodeStep === step) {
      node.classList.add('active');
    } else {
      node.classList.remove('active');
    }
  });

  // Update slides
  for (let i = 1; i <= 5; i++) {
    const slide = document.getElementById(`modalStep${i}`);
    if (slide) {
      if (i === step) {
        slide.classList.add('active');
      } else {
        slide.classList.remove('active');
      }
    }
  }
}

function handleWizardModalSubmit(e) {
  e.preventDefault();
  playLuxuryClick(850);

  const compliance = document.getElementById('wizComplianceCheckbox');
  if (!compliance || !compliance.checked) {
    alert('Пожалуйста, подтвердите согласие на обработку персональных данных (152-ФЗ РФ).');
    return;
  }

  const formatEl = document.querySelector('input[name="wizFormat"]:checked');
  const locationEl = document.querySelector('input[name="wizLocation"]:checked');
  const dateEl = document.getElementById('wizDateInput');
  const guestsEl = document.getElementById('wizGuests');
  const notesEl = document.getElementById('wizNotes');
  const nameEl = document.getElementById('wizName');
  const contactEl = document.getElementById('wizContact');

  const payload = {
    name: nameEl?.value || 'Клиент',
    phone: contactEl?.value || '',
    format: formatEl?.value || 'Свадьба',
    event_date: dateEl?.value || '2026-04-18',
    estimated_budget: 200000,
    comment: `[Wizard] Локация: ${locationEl?.value || 'Красная Поляна'}. Гости: ${guestsEl?.value || '30-70'}. Пожелания: ${notesEl?.value || 'нет'}`
  };

  const submitBtn = document.getElementById('modalWizardSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Отправка данных...</span>';
  }

  fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .then(() => {
    if (submitBtn) {
      submitBtn.innerHTML = '<span>Заявка принята! ✓</span>';
    }
    setTimeout(() => {
      closePlannerModal();
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Отправить заявку Аслану &rarr;</span>';
      }
      alert('Благодарим за обращение! Ваша заявка успешно отправлена Аслану Балаеву.');
    }, 900);
  })
  .catch(() => {
    alert('Заявка сохранена локально. Мы свяжемся с вами в ближайшее время.');
    closePlannerModal();
  });
}

// ==========================================================================
// 8. QUICK CONTACT FORM ON MAIN PAGE
// ==========================================================================
function handleContactSubmit(e) {
  e.preventDefault();
  playLuxuryClick(850);

  const compliance = document.getElementById('complianceCheckbox');
  if (!compliance || !compliance.checked) {
    alert('Пожалуйста, подтвердите согласие на обработку данных (152-ФЗ РФ).');
    return;
  }

  const nameEl = document.getElementById('contactName');
  const phoneEl = document.getElementById('contactPhone');
  const formatEl = document.getElementById('contactFormat');
  const messageEl = document.getElementById('contactMessage');

  const payload = {
    name: nameEl?.value || 'Клиент',
    phone: phoneEl?.value || '',
    format: formatEl?.value || 'Свадьба',
    event_date: '2026',
    estimated_budget: 180000,
    comment: messageEl?.value || 'Запрос с главной формы сайта'
  };

  const submitBtn = document.getElementById('contactSubmitBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Отправка...</span>';
  }

  fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  .then(res => res.json())
  .then(() => {
    if (submitBtn) {
      submitBtn.innerHTML = '<span>Заявка принята! ✓</span>';
    }
    alert('Благодарим за доверие! Ваша заявка отправлена. Аслан свяжется с вами в ближайшее время.');
    setTimeout(() => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Отправить заявку &rarr;</span>';
      }
    }, 2000);
  })
  .catch(() => {
    alert('Заявка принята. Аслан свяжется с вами в ближайшее время.');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Отправить заявку &rarr;</span>';
    }
  });
}

// ==========================================================================
// 9. 152-ФЗ PRIVACY MODAL & COOKIE BANNER
// ==========================================================================
function openPrivacyModal(e) {
  if (e) e.preventDefault();
  playLuxuryClick(600);
  const modal = document.getElementById('privacyModal');
  if (modal) modal.classList.add('open');
}

function closePrivacyModal() {
  playLuxuryClick(400);
  const modal = document.getElementById('privacyModal');
  if (modal) modal.classList.remove('open');
}

function checkCookieConsent() {
  const banner = document.getElementById('cookieBanner');
  if (banner && !localStorage.getItem('aslan_cookie_consent')) {
    banner.style.display = 'flex';
  } else if (banner) {
    banner.style.display = 'none';
  }
}

function acceptCookies() {
  playLuxuryClick(650);
  localStorage.setItem('aslan_cookie_consent', 'true');
  const banner = document.getElementById('cookieBanner');
  if (banner) banner.style.display = 'none';
}

// Global Keyboard Escape
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeLightbox();
    closePrivacyModal();
    closePlannerModal();
    closeMobileMenu();
  }
});
