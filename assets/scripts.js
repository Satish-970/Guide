// =============================
// assets/scripts.js
// Centralized JS: Guide (Sidebar, Scroll, Copy) + Tracker (Progress, Chatbot)
// Detect page type via class or ID | 2025 Edition
// =============================

document.addEventListener("DOMContentLoaded", function () {

  const isGuidePage = document.querySelector('.content.panel');
  const isTrackerPage = document.querySelector('.table-container');

  // ----------------------------
  // GUIDE FEATURES (Sidebar, Smooth Scroll, Copy, Modal, Year)
  // ----------------------------
  if (isGuidePage) {
    // Sidebar Toggle
    const sidebar = document.querySelector('.sidebar');
    const toggleBtn = document.querySelector('.sidebar-toggle');
    if (toggleBtn && sidebar) {
      toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        toggleBtn.textContent = sidebar.classList.contains('open') ? '✕ Close' : '☰ Menu';
      });

      // Close on outside click (mobile)
      document.addEventListener('click', (e) => {
        if (window.innerWidth <= 968 && sidebar.classList.contains('open') &&
            !sidebar.contains(e.target) && !toggleBtn.contains(e.target)) {
          sidebar.classList.remove('open');
          toggleBtn.textContent = '☰ Menu';
        }
      });
    }

    // Close sidebar on TOC click (mobile)
    document.querySelectorAll('.toc a, .subtoc a').forEach(link => {
      link.addEventListener('click', () => {
        if (window.innerWidth <= 968) {
          sidebar.classList.remove('open');
          toggleBtn.textContent = '☰ Menu';
        }
      });
    });

    // Smooth Scroll + URL Update
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
      anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');
        if (href === '#' || href === '') return;
        const target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.pushState(null, null, href);
        }
      });
    });

    // Load hash scroll
    if (window.location.hash) {
      setTimeout(() => {
        const target = document.querySelector(window.location.hash);
        if (target) target.scrollIntoView({ behavior: 'smooth' });
      }, 300);
    }

    // Copy Code
    window.copyCode = function (codeBlockId) {
      const block = document.getElementById(codeBlockId);
      if (!block) return;
      const codeText = block.innerText.replace(/Copy.*$/g, '').trim();
      navigator.clipboard.writeText(codeText).then(() => {
        const button = block.querySelector('.copy');
        if (button) {
          const original = button.textContent;
          button.textContent = 'Copied!';
          button.style.background = '#00ff88';
          setTimeout(() => {
            button.textContent = original;
            button.style.background = '';
          }, 1500);
        }
      }).catch(() => alert('Copy failed!'));
    };

    // Modal
    const modal = document.getElementById('modal');
    const modalCode = document.getElementById('modal-code');
    window.openModalWithCode = function (id) {
      const block = document.getElementById(id);
      if (!block || !modal || !modalCode) return;
      modalCode.textContent = block.innerText.replace(/Copy.*$/g, '').trim();
      modal.style.display = 'flex';
      modalCode.scrollTop = 0;
    };
    window.closeModal = function () {
      if (modal) modal.style.display = 'none';
    };
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
      });
    }

    // TOC Highlight
    const tocLinks = document.querySelectorAll('.toc a, .subtoc a');
    const sections = Array.from(tocLinks).map(link => ({
      link, target: document.querySelector(link.getAttribute('href'))
    })).filter(item => item.target);
    function highlightToc() {
      let current = '';
      sections.forEach(sec => {
        const rect = sec.target.getBoundingClientRect();
        if (rect.top <= 100 && rect.bottom > 100) current = sec.link;
      });
      tocLinks.forEach(link => link.classList.remove('active'));
      if (current) current.classList.add('active');
    }
    window.addEventListener('scroll', highlightToc);
    highlightToc();
  }

  // ----------------------------
  // TRACKER FEATURES (Progress, Heatmap, Filters, Chatbot, Excel, etc.)
  // ----------------------------
  if (isTrackerPage) {
    // Assume global vars like dsaProblems, statusData, etc. are defined in page script
    // Year Update (shared)
    const year = new Date().getFullYear();
    document.querySelectorAll('#year, #year-sidebar').forEach(el => el.textContent = year);

    // Focus Mode
    window.toggleFocusMode = function () {
      document.body.classList.toggle('focus-mode');
      const btn = document.querySelector('.focus-mode-toggle');
      if (btn) btn.textContent = document.body.classList.contains('focus-mode') ? '🏠 Exit Focus' : '🎯 Focus Mode';
    };

    // Chatbot
    window.toggleChatbot = function () {
      document.getElementById('chatbotWindow').classList.toggle('active');
    };
    // Assume javaKnowledge object defined in page for Java-specific responses
    const javaKnowledge = {
      // Similar to dsaKnowledge but for Java
      'what is java': 'Java is a high-level, object-oriented programming language designed for platform independence. Created by James Gosling at Sun Microsystems in 1995, it runs on the JVM, enabling "Write Once, Run Anywhere." Key features: OOP, garbage collection, multithreading, and vast standard library.',
      // Add more entries...
      'oop in java': 'OOP in Java revolves around four pillars: Encapsulation (data hiding), Inheritance (reusability), Polymorphism (flexibility), Abstraction (simplification). Java enforces OOP strictly—everything is an object (except primitives). Use classes for blueprints, interfaces for contracts.',
      'collections': 'Java Collections Framework (java.util) provides resizable data structures: Lists (ordered), Sets (unique), Maps (key-value), Queues (FIFO). Core: ArrayList (dynamic array), HashMap (hash table), TreeSet (sorted set). Essential for DSA—know time complexities!',
      'threads': 'Multithreading in Java allows concurrent execution. Create via Thread class or Runnable interface. Manage with synchronized, Locks, Executors. Java 21 introduces virtual threads for lightweight concurrency. Pitfalls: race conditions, deadlocks—use volatile for visibility.',
      'best practices': 'Java Best Practices: 1) Favor immutability (final fields), 2) Use try-with-resources for I/O, 3) Override equals/hashCode properly, 4) Prefer Streams over loops, 5) Tune GC for performance, 6) Write unit tests (JUnit), 7) Follow SOLID principles for clean code.'
      // Expand with all Java topics...
    };
    window.askQuestion = function (question) {
      document.getElementById('chatInput').value = question;
      sendMessage();
    };
    window.sendMessage = function () {
      const input = document.getElementById('chatInput');
      const message = input.value.trim();
      if (!message) return;
      const messagesContainer = document.getElementById('chatbotMessages');
      const userMsg = document.createElement('div');
      userMsg.className = 'chat-message user';
      userMsg.innerHTML = `<p>${message}</p>`;
      messagesContainer.appendChild(userMsg);
      setTimeout(() => {
        const botMsg = document.createElement('div');
        botMsg.className = 'chat-message bot';
        const lowerMessage = message.toLowerCase();
        let response = "I'm your Java expert! Ask about OOP, Collections, Threads, JVM, Streams, or best practices.";
        let bestMatch = '';
        let bestMatchLength = 0;
        for (const [key, value] of Object.entries(javaKnowledge)) {
          if (lowerMessage.includes(key) && key.length > bestMatchLength) {
            bestMatch = key;
            bestMatchLength = key.length;
            response = value;
          }
        }
        botMsg.innerHTML = `<p>${response}</p>`;
        messagesContainer.appendChild(botMsg);
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }, 500);
      input.value = '';
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    };
    window.handleChatKeyPress = function (event) {
      if (event.key === 'Enter') sendMessage();
    };

    // Other tracker functions (updateStatus, filterTable, etc.) go here or in page script
    // For brevity, assume they are inlined in tracker HTML as before
  }

  // Shared Year Update
  document.querySelectorAll('#year, #year-sidebar').forEach(el => {
    if (el) el.textContent = new Date().getFullYear();
  });
});