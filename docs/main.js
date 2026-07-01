(() => {
  const GITHUB_URL = "https://github.com/aa2246740/pi-fusion";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGSAP = typeof window.gsap !== "undefined" && typeof window.ScrollTrigger !== "undefined";

  const copyLabels = {
    en: { copy: "Copy", copied: "Copied", select: "Select + copy" },
    zh: { copy: "复制", copied: "已复制", select: "选择后复制" },
  };

  const i18n = {
    en: {
      metaTitle: "Pi Fusion - DRACO-verified model fusion for Pi agents",
      metaDescription: "Pi Fusion is DRACO-verified model fusion for Pi agents: scored full10 validation, prompt-only generation, scorer-only rubric access, and local artifacts.",
      skip: "Skip to content",
      toggleNav: "Toggle navigation",
      navOverview: "Overview",
      navFeatures: "Features",
      navWorkflow: "Workflow",
      navBenchmarks: "Benchmarks",
      navDocs: "Docs",
      navGithub: "GitHub",
      languageToggle: "中文",
      heroEyebrow: "DRACO-verified model fusion for Pi agents",
      heroHeadline: "Not just a fusion demo. Scored on DRACO full10.",
      heroLede: "Pi Fusion turns one high-stakes prompt into independent model answers, then uses judge synthesis, verification, and scorer-only benchmark validation to make the result inspectable instead of just plausible.",
      installCta: "Install Pi Fusion",
      workflowCta: "See the workflow",
      githubCta: "Open GitHub",
      installLabel: "Install",
      copy: "Copy",
      trustRow: "DRACO full10 scored · Prompt-only generation · Scorer-only rubric access",
      judge: "Judge",
      artifactText: "Scored artifact trail",
      problemEyebrow: "The single-model problem",
      problemHeading: "One model answer isn't always enough.",
      problemCopy: "When the stakes are high, a single response can miss tradeoffs, bury contradictions, or commit to one viewpoint before alternatives are even considered.",
      solutionEyebrow: "The fusion answer",
      solutionHeading: "Run a panel. Reconcile differences. Decide with evidence.",
      solutionCopy: "Pi Fusion runs multiple participant models in parallel, compares their answers, and uses a judge model to synthesize a final response - with optional evidence gathering, verification, and durable artifacts kept locally.",
      featuresEyebrow: "Capabilities",
      featuresHeading: "Built for decisions that deserve more than one guess.",
      featuresIntro: "Use it for research, planning, architecture decisions, debugging hypotheses, code review, vendor comparisons, writing, and document synthesis.",
      feature1Title: "Parallel participant models",
      feature1Copy: "Independent answers from multiple models, side by side.",
      feature2Title: "Judge synthesis",
      feature2Copy: "A judge model reconciles, notes contradictions, and reports the final answer.",
      feature3Title: "Verification & revision",
      feature3Copy: "Optionally re-check and refine before the answer is final.",
      feature4Title: "Optional evidence layer",
      feature4Copy: "Connect provider-agnostic search and fetch tools when current, sourced answers matter.",
      feature5Title: "Local artifacts & costs",
      feature5Copy: "Evidence summaries, token usage, and cost reporting stay with you.",
      feature6Title: "Fallback & retry policy",
      feature6Copy: "Configurable fallback and retry behavior keeps panel runs resilient.",
      workflowEyebrow: "Workflow",
      workflowHeading: "From prompt to scored artifact.",
      workflowIntro: "The panel fans out, evidence is attached when available, and the judge turns disagreement into a stronger answer that can be benchmarked after generation is sealed.",
      step1Title: "Prompt in",
      step1Copy: "One prompt enters the fusion panel.",
      step2Title: "Parallel answers",
      step2Copy: "Participant models respond independently.",
      step3Title: "Evidence optional",
      step3Copy: "Search, fetch, and local read-only context can be used when configured.",
      step4Title: "Judge synthesis",
      step4Copy: "The judge compares agreements, contradictions, and missing evidence.",
      step5Title: "Verified artifact",
      step5Copy: "The final answer, evidence summary, token usage, and cost report are saved locally.",
      commandsEyebrow: "Pi-native",
      commandsHeading: "Three commands. That's the surface area.",
      commandsIntro: "Configure the panel, diagnose availability, then run fusion from the place you already work.",
      commandsLabel: "Commands",
      examplesLabel: "Examples",
      benchEyebrow: "DRACO benchmark",
      benchHeading: "Scored DRACO validation above the reported Fusion API result.",
      benchIntro: "Pi Fusion is not just a demo of multi-model prompting. On a sealed fixed DRACO-10 validation run, final answers were generated from prompt-only cases, then the scorer loaded rubric artifacts only after the answers were sealed. Pi Fusion scored 73.80: +4.80 above the reported Fusion API 69.00 headline result and +9.10 above the reported 64.70 budget baseline.",
      metricPeak: "Latest DRACO-10",
      metricDelta: "Delta vs Fusion API",
      metricFailures: "Judge failures",
      benchVideoCaption: "A real scoring-stage recording: final answers are already sealed, then the scorer loads the rubric and produces DRACO scores.",
      verifyHeading: "Verification checklist",
      verifyCasesLabel: "Cases",
      verifyCasesValue: "10/10 completed",
      verifyGenerationLabel: "Generation input",
      verifyGenerationValue: "Sanitized prompt-only cases",
      verifyRubricLabel: "Rubric access",
      verifyRubricValue: "Scorer-only after seal",
      verifyBaselineLabel: "Comparison",
      verifyBaselineValue: "Fusion API 69.00 / budget 64.70",
      verifyArtifactLabel: "Public artifacts",
      verifyArtifactValue: "Sanitized aggregates only",
      tableSystem: "System / run",
      tableDelta: "Delta vs reported Fusion API",
      tableBudgetDelta: "Delta vs reported budget",
      rowBudget: "Reported Fusion API budget baseline",
      rowLatest: "Pi Fusion latest sealed DRACO-10 validation",
      rowFusion: "Reported Fusion API headline result",
      benchFootnote: "DRACO-verified here means completed scored runs under this fixed 10-case validation protocol. It is not official DRACO certification or a claim that Pi Fusion beats every Fusion API mode on every evaluation. Generation used sanitized prompt-only case files; answer/rubric/scoring artifacts were available only to the post-generation scorer.",
      safetyEyebrow: "Safety & control",
      safetyHeading: "Powerful tools, kept on a short leash.",
      safetyIntro: "Participant models work in isolated writable workspace copies. No multi-agent writes are applied to your real workspace during a Fusion Run.",
      safe1Title: "Workspace sandboxes",
      safe1Copy: "Each participant gets its own project copy with scoped list, search, read, write, and edit tools.",
      safe2Title: "Reviewable ChangeSets",
      safe2Copy: "Sandbox roots, changed files, and ChangeSet artifacts stay local for review.",
      safe3Title: "Optional backends",
      safe3Copy: "Fusion still works without search or fetch tools.",
      safe4Title: "Pi-native control",
      safe4Copy: "You choose the models, fallbacks, tools, and reporting behavior.",
      docsEyebrow: "Docs",
      docsHeading: "English-first repo, Chinese docs included.",
      docsIntro: "The GitHub repository is English-first for open-source discoverability, with Chinese documentation for local users and contributors.",
      docReadme: "README",
      docChinese: "Chinese README",
      docBench: "Benchmark notes",
      docBenchZh: "Chinese benchmark notes",
      finalEyebrow: "Install",
      finalHeading: "Put your next hard question to a panel.",
      finalIntro: "Install Pi Fusion, configure your participant and judge models, then run your first fusion panel in minutes.",
      configureCta: "Configure models",
      doctorCta: "Run /pi-fusion-doctor",
      footerTagline: "DRACO-verified model fusion for Pi agents.",
      footerProduct: "Product",
      footerResources: "Resources",
      footerProject: "Project",
      footerBottom: "Built for decisions that deserve more than one guess.",
      license: "MIT License",
    },
    zh: {
      metaTitle: "Pi Fusion - 经过 DRACO 评分验证的 Pi agents 模型融合",
      metaDescription: "Pi Fusion 是经过 DRACO 评分验证的 Pi agents 模型融合：full10 scored validation、prompt-only generation、scorer-only rubric access 和本地 artifacts。",
      skip: "跳到正文",
      toggleNav: "切换导航",
      navOverview: "概览",
      navFeatures: "能力",
      navWorkflow: "流程",
      navBenchmarks: "基准",
      navDocs: "文档",
      navGithub: "GitHub",
      languageToggle: "English",
      heroEyebrow: "经过 DRACO 评分验证的 Pi agents 模型融合",
      heroHeadline: "不只是 fusion demo，而是跑过 DRACO full10 评分。",
      heroLede: "Pi Fusion 会把高风险问题分发给独立模型，再用 judge synthesis、verification 和 scorer-only benchmark validation，让结果不只是看起来合理，而是可检查、可评分。",
      installCta: "安装 Pi Fusion",
      workflowCta: "查看流程",
      githubCta: "打开 GitHub",
      installLabel: "安装",
      copy: "复制",
      trustRow: "DRACO full10 scored · Prompt-only generation · Scorer-only rubric access",
      judge: "裁判",
      artifactText: "评分 artifact trail",
      problemEyebrow: "单模型问题",
      problemHeading: "一个模型的答案不总是够用。",
      problemCopy: "当问题重要时，单次回答可能遗漏权衡、掩盖矛盾，或者在充分比较前就锁定一个视角。",
      solutionEyebrow: "Fusion 解法",
      solutionHeading: "运行模型小组，整理分歧，基于证据决策。",
      solutionCopy: "Pi Fusion 并行运行多个 participant model，对比它们的答案，再用 judge model 综合最终回复；需要时可以加入 evidence、验证流程和本地持久化 artifact。",
      featuresEyebrow: "能力",
      featuresHeading: "为值得多问一遍的问题而建。",
      featuresIntro: "适合研究、规划、架构决策、调试假设、代码评审、供应商比较、写作和文档综合。",
      feature1Title: "并行 participant models",
      feature1Copy: "多个模型独立作答，并列比较。",
      feature2Title: "Judge synthesis",
      feature2Copy: "裁判模型整合结论、标出矛盾，并输出最终答案。",
      feature3Title: "验证与修订",
      feature3Copy: "可选地再次检查并修订，再交付最终答案。",
      feature4Title: "可选 evidence layer",
      feature4Copy: "当问题需要现时信息或来源支撑时，接入通用搜索和抓取工具。",
      feature5Title: "本地 artifact 和成本",
      feature5Copy: "Evidence 摘要、token 用量和成本报告都留在本地。",
      feature6Title: "Fallback 和 retry 策略",
      feature6Copy: "可配置的 fallback 与 retry，让小组运行更稳。",
      workflowEyebrow: "流程",
      workflowHeading: "从 prompt 到可评分 artifact。",
      workflowIntro: "问题分发给模型小组，必要时附上 evidence；generation sealed 之后，结果可以进入 benchmark scoring。",
      step1Title: "输入 prompt",
      step1Copy: "一个问题进入 fusion panel。",
      step2Title: "并行回答",
      step2Copy: "Participant models 独立生成答案。",
      step3Title: "Evidence 可选",
      step3Copy: "配置后可使用搜索、抓取和只读本地上下文。",
      step4Title: "裁判综合",
      step4Copy: "Judge 比较共识、矛盾和缺失证据。",
      step5Title: "验证后的 artifact",
      step5Copy: "最终答案、evidence 摘要、token 用量和成本报告会保存到本地。",
      commandsEyebrow: "Pi 原生命令",
      commandsHeading: "三个命令，就是全部入口。",
      commandsIntro: "配置模型小组，诊断可用性，然后在你工作的地方直接运行 fusion。",
      commandsLabel: "命令",
      examplesLabel: "示例",
      benchEyebrow: "DRACO 基准",
      benchHeading: "有评分的 DRACO validation，高于 reported Fusion API result。",
      benchIntro: "Pi Fusion 不只是 multi-model prompting 的 demo。在 sealed fixed DRACO-10 validation run 中，final answers 先从 prompt-only cases 生成，answers sealed 之后 scorer 才加载 rubric artifacts。Pi Fusion 得分 73.80，比 reported Fusion API 69.00 headline result 高 +4.80，比 reported 64.70 budget baseline 高 +9.10。",
      metricPeak: "Latest DRACO-10",
      metricDelta: "相对 Fusion API",
      metricFailures: "Judge failures",
      benchVideoCaption: "真实 scoring 阶段录屏：final answers 已经 sealed，之后 scorer 才加载 rubric 并产出 DRACO scores。",
      verifyHeading: "验证 checklist",
      verifyCasesLabel: "Cases",
      verifyCasesValue: "10/10 完成",
      verifyGenerationLabel: "Generation input",
      verifyGenerationValue: "Sanitized prompt-only cases",
      verifyRubricLabel: "Rubric access",
      verifyRubricValue: "Sealed 之后 scorer-only",
      verifyBaselineLabel: "对比",
      verifyBaselineValue: "Fusion API 69.00 / budget 64.70",
      verifyArtifactLabel: "Public artifacts",
      verifyArtifactValue: "只发布 sanitized aggregates",
      tableSystem: "系统 / 运行",
      tableDelta: "相对 reported Fusion API",
      tableBudgetDelta: "相对 reported budget",
      rowBudget: "Reported Fusion API budget baseline",
      rowLatest: "Pi Fusion latest sealed DRACO-10 validation",
      rowFusion: "Reported Fusion API headline result",
      benchFootnote: "这里的 DRACO-verified 指的是在这个 fixed 10-case validation protocol 下完成 scored runs；不是 DRACO 官方认证，也不是说 Pi Fusion 在所有评估里超过所有 Fusion API modes。生成阶段只使用 sanitized prompt-only case files；answer/rubric/scoring artifacts 只提供给 generation 之后的 scorer。",
      safetyEyebrow: "安全与控制",
      safetyHeading: "强工具，但边界明确。",
      safetyIntro: "Participant models 会在独立可写 workspace copy 中工作。Fusion Run 不会把多 agent 写入直接应用到真实 workspace。",
      safe1Title: "Workspace sandboxes",
      safe1Copy: "每个 participant 都有自己的项目副本，以及受限的 list、search、read、write、edit tools。",
      safe2Title: "可审查 ChangeSets",
      safe2Copy: "Sandbox root、变更文件和 ChangeSet artifacts 都保存在本地供审查。",
      safe3Title: "可选后端",
      safe3Copy: "即使没有搜索或抓取工具，Fusion 仍然可以运行。",
      safe4Title: "Pi 原生控制",
      safe4Copy: "你选择模型、fallback、工具和报告方式。",
      docsEyebrow: "文档",
      docsHeading: "仓库英文优先，也包含中文文档。",
      docsIntro: "GitHub 仓库为了开源可发现性采用英文优先，同时提供中文文档，方便本地用户和贡献者使用。",
      docReadme: "英文 README",
      docChinese: "中文 README",
      docBench: "英文基准说明",
      docBenchZh: "中文基准说明",
      finalEyebrow: "安装",
      finalHeading: "把下一个难题交给模型小组。",
      finalIntro: "安装 Pi Fusion，配置 participant 和 judge models，然后几分钟内运行第一次 fusion panel。",
      configureCta: "配置模型",
      doctorCta: "运行 /pi-fusion-doctor",
      footerTagline: "经过 DRACO 评分验证的 Pi agents 模型融合。",
      footerProduct: "产品",
      footerResources: "资源",
      footerProject: "项目",
      footerBottom: "为值得多问一遍的问题而建。",
      license: "MIT License",
    },
  };

  const revealAll = () => {
    document.querySelectorAll("[data-reveal]").forEach((el) => {
      el.classList.add("is-visible");
      el.style.opacity = "1";
      el.style.visibility = "visible";
    });
  };

  function getStoredLanguage() {
    const stored = window.localStorage.getItem("pi-fusion-language");
    if (stored === "en" || stored === "zh") return stored;
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function applyRepositoryLinks() {
    document.querySelectorAll("[data-github-link]").forEach((link) => {
      link.setAttribute("href", GITHUB_URL);
    });

    document.querySelectorAll("[data-repo-path]").forEach((link) => {
      const path = link.getAttribute("data-repo-path");
      if (path) link.setAttribute("href", `${GITHUB_URL}/blob/main/${path}`);
    });

    const installCommand = document.querySelector("[data-install-command]");
    if (installCommand) {
      installCommand.textContent = `pi install git:${GITHUB_URL}@main`;
    }
  }

  function applyLanguage(lang) {
    const dictionary = i18n[lang] || i18n.en;
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.lang = lang;
    document.title = dictionary.metaTitle;

    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute("content", dictionary.metaDescription);

    document.querySelectorAll("[data-i18n]").forEach((node) => {
      const key = node.getAttribute("data-i18n");
      if (key && dictionary[key]) node.textContent = dictionary[key];
    });

    const toggle = document.querySelector("[data-language-toggle]");
    if (toggle) {
      toggle.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切换到中文");
    }
  }

  function initLanguageToggle() {
    let current = getStoredLanguage();
    applyLanguage(current);

    const toggle = document.querySelector("[data-language-toggle]");
    if (!toggle) return;

    toggle.addEventListener("click", () => {
      current = current === "zh" ? "en" : "zh";
      window.localStorage.setItem("pi-fusion-language", current);
      applyLanguage(current);
    });
  }

  function initMobileNav() {
    const toggle = document.querySelector(".nav-toggle");
    const links = document.querySelector(".nav-links");
    if (!toggle || !links) return;

    toggle.addEventListener("click", () => {
      const isOpen = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });

    links.addEventListener("click", (event) => {
      if (event.target instanceof HTMLAnchorElement) {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  function currentCopyLabels() {
    const lang = document.documentElement.dataset.lang === "zh" ? "zh" : "en";
    return copyLabels[lang];
  }

  function initCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const selector = button.getAttribute("data-copy");
        const target = selector ? document.querySelector(selector) : null;
        if (!target) return;
        const text = target.textContent.trim();
        const labels = currentCopyLabels();

        try {
          await navigator.clipboard.writeText(text);
          button.textContent = labels.copied;
        } catch {
          const range = document.createRange();
          range.selectNodeContents(target);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          button.textContent = labels.select;
        }

        window.setTimeout(() => {
          button.textContent = currentCopyLabels().copy;
        }, 1500);
      });
    });
  }

  function setActiveStep(index) {
    document.querySelectorAll(".workflow-step").forEach((step, i) => {
      step.classList.toggle("is-active", i === index);
    });
  }

  function initHero(gsap) {
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.from(".topbar", { y: -18, duration: 0.55 })
      .from(".hero .eyebrow, .hero h1, .hero-lede, .hero-actions, .hero-command, .trust-row", {
        y: 26,
        duration: 0.72,
        stagger: 0.075,
      }, "-=0.15")
      .from(".visual-shell", { scale: 0.94, duration: 0.85 }, "-=0.58")
      .from(".participant", { scale: 0.65, stagger: 0.08, duration: 0.45, ease: "back.out(1.8)" }, "-=0.45")
      .from(".beam", { scaleY: 0, transformOrigin: "top", stagger: 0.12, duration: 0.55 }, "-=0.35")
      .from(".artifact-card", { y: 18, duration: 0.45 }, "-=0.2");

    gsap.to(".participant", {
      y: (i) => (i % 2 ? 9 : -9),
      x: (i) => (i < 2 ? 5 : -5),
      repeat: -1,
      yoyo: true,
      duration: 2.6,
      ease: "sine.inOut",
      stagger: { each: 0.22, from: "random" },
    });
  }

  function initReveals(gsap, ScrollTrigger) {
    gsap.utils.toArray("[data-reveal]").forEach((el) => {
      if (el.closest(".hero") || el.classList.contains("topbar")) return;
      gsap.fromTo(el, { y: 18 }, {
        y: 0,
        duration: 0.68,
        ease: "power2.out",
        scrollTrigger: {
          trigger: el,
          start: "top 85%",
          once: true,
        },
      });
    });
  }

  function initWorkflow(gsap) {
    const mm = gsap.matchMedia();
    mm.add("(min-width: 1101px)", () => {
      const steps = gsap.utils.toArray(".workflow-step");
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: "#workflow",
          start: "top top",
          end: "+=250%",
          scrub: 0.7,
          pin: true,
          anticipatePin: 1,
        },
      });

      tl.to(".workflow-progress-fill", { width: "100%", ease: "none" }, 0);
      steps.forEach((step, index) => {
        const position = index / Math.max(1, steps.length - 1);
        tl.call(() => setActiveStep(index), [], position);
        tl.to(step, { borderColor: "rgba(57,213,232,0.36)", duration: 0.08 }, position);
      });

      return () => setActiveStep(0);
    });
  }

  function initBenchmarks(gsap) {
    const metric = document.querySelector("[data-count-to]");
    if (!metric) return;
    const target = Number.parseFloat(metric.dataset.countTo || "0");
    gsap.fromTo({ value: 0 }, { value: target }, {
      value: target,
      duration: 1.1,
      ease: "power2.out",
      scrollTrigger: { trigger: "#benchmarks", start: "top 78%", once: true },
      onUpdate() {
        metric.textContent = `+${this.targets()[0].value.toFixed(2)}`;
      },
    });

    gsap.from("#benchmarks tbody tr", {
      y: 14,
      stagger: 0.08,
      duration: 0.5,
      ease: "power2.out",
      scrollTrigger: { trigger: ".table-wrap", start: "top 82%", once: true },
    });
  }

  function initAnimations() {
    const gsap = window.gsap;
    const ScrollTrigger = window.ScrollTrigger;
    gsap.registerPlugin(ScrollTrigger);

    gsap.set("[data-reveal]", { opacity: 1, visibility: "visible" });
    document.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-visible"));

    initHero(gsap);
    initReveals(gsap, ScrollTrigger);
    initWorkflow(gsap, ScrollTrigger);
    initBenchmarks(gsap);

    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => ScrollTrigger.refresh(), 180);
    });

    window.setTimeout(revealAll, 2200);
  }

  applyRepositoryLinks();
  initLanguageToggle();
  initMobileNav();
  initCopyButtons();

  if (!hasGSAP || reduce) {
    revealAll();
    return;
  }

  initAnimations();
})();
