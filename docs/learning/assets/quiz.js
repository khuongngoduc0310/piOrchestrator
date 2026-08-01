/**
 * LessonQuiz — reusable quiz widget for the piOrchestrator learning course.
 *
 * Depends on nothing. Load after lesson.css.
 *
 * Usage:
 *   <div id="quiz-1"></div>
 *   <script src="../assets/quiz.js"></script>
 *   <script>
 *     LessonQuiz.render(document.getElementById("quiz-1"), {
 *       title: "Check your map",
 *       questions: [
 *         { type: "choice", prompt: "...", options: [
 *           { label: "the orchestrator", correct: true, note: "..." },
 *           { label: "...", correct: false, note: "..." }
 *         ]},
 *         { type: "order", prompt: "...", items: [
 *           { label: "Explore", position: 1 },
 *           { label: "Plan", position: 2 }
 *         ], note: "..." }
 *       ]
 *     });
 *   </script>
 *
 * Question types:
 *  - "choice": click an option. One attempt; wrong picks reveal the correct
 *    answer immediately so the feedback loop stays tight.
 *  - "order": click the items in the correct sequence. Each full attempt is
 *    validated; wrong positions are marked so the learner can retry.
 */
(function () {
  "use strict";

  var CORRECT = "\u2713";
  var WRONG = "\u2717";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function shuffle(items, seed) {
    var out = items.slice();
    var state = seed || 1;
    for (var i = out.length - 1; i > 0; i--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      var j = state % (i + 1);
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function renderChoice(question, container, onSolved) {
    var feedback = el("p", "quiz-feedback");
    var options = el("div", "quiz-options");

    question.options.forEach(function (option) {
      var button = el("button", "quiz-option", option.label);
      button.type = "button";
      button.addEventListener("click", function () {
        if (button.disabled) return;
        Array.prototype.forEach.call(options.children, function (child) {
          child.disabled = true;
        });
        if (option.correct) {
          button.classList.add("correct");
          button.appendChild(el("span", "mark", CORRECT));
          feedback.textContent = "Correct. " + (option.note || "");
          feedback.className = "quiz-feedback ok";
          onSolved();
        } else {
          button.classList.add("wrong");
          button.appendChild(el("span", "mark", WRONG));
          var correctLabel = question.options.filter(function (o) { return o.correct; })[0].label;
          feedback.textContent = "Not quite — the right answer is: " + correctLabel + ". " + (option.note || "");
          feedback.className = "quiz-feedback no";
        }
      });
      options.appendChild(button);
    });

    container.appendChild(options);
    container.appendChild(feedback);
  }

  function renderOrder(question, container, onSolved) {
    var feedback = el("p", "quiz-feedback");
    var progress = el("p", "order-progress");
    var list = el("div", "order-items");
    var retry = el("button", "order-retry", "Try again");
    retry.type = "button";
    retry.style.display = "none";
    var solved = false;
    var correctOrder = question.items.slice().sort(function (a, b) { return a.position - b.position; });
    var seed = hash(question.prompt || "");
    var order = shuffle(correctOrder, seed);
    var picked = [];

    var build = function () {
      list.textContent = "";
      order.forEach(function (item) {
        var button = el("button", "order-item", item.label);
        button.type = "button";
        button.addEventListener("click", function () {
          if (button.disabled) return;
          var index = picked.indexOf(item);
          if (index === -1) {
            picked.push(item);
            button.classList.add("picked");
          } else {
            picked.splice(index, 1);
            button.classList.remove("picked");
          }
          progress.textContent = "Clicked: " + picked.length + " / " + order.length + " — click in the order they run.";
          if (picked.length === order.length) evaluate();
        });
        list.appendChild(button);
      });
    };

    var evaluate = function () {
      var wrong = 0;
      picked.forEach(function (item, index) {
        if (item.position !== index + 1) wrong++;
      });
      Array.prototype.forEach.call(list.children, function (child, index) {
        child.disabled = true;
        if (picked[index].position === index + 1) child.classList.add("ok");
        else child.classList.add("no");
      });
      if (wrong === 0) {
        feedback.textContent = "Correct order. " + (question.note || "");
        feedback.className = "quiz-feedback ok";
        if (!solved) {
          solved = true;
          onSolved();
        }
      } else {
        feedback.textContent =
          wrong + " out of place — the " + (wrong === 1 ? "highlighted item" : "highlighted items") +
          " run at a different point. " + (question.note || "");
        feedback.className = "quiz-feedback no";
        retry.style.display = "";
      }
    };

    retry.addEventListener("click", function () {
      picked = [];
      Array.prototype.forEach.call(list.children, function (child) {
        child.disabled = false;
        child.classList.remove("picked", "ok", "no");
      });
      feedback.textContent = "";
      feedback.className = "quiz-feedback";
      retry.style.display = "none";
      progress.textContent = "Clicked: 0 / " + order.length + " — click in the order they run.";
    });

    build();
    container.appendChild(list);
    container.appendChild(progress);
    container.appendChild(feedback);
    container.appendChild(retry);
  }

  function render(container, quiz) {
    var correct = 0;
    var total = quiz.questions.length;

    quiz.questions.forEach(function (question, index) {
      var card = el("div", "quiz-question");
      card.appendChild(el("span", "q-label", "Question " + (index + 1)));
      card.appendChild(el("p", "q-prompt", question.prompt));

      var onSolved = function () {
        correct++;
        score.textContent = "Score: " + correct + " / " + total;
      };

      if (question.type === "order") renderOrder(question, card, onSolved);
      else renderChoice(question, card, onSolved);

      container.appendChild(card);
    });

    var score = el("p", "quiz-score", "Score: 0 / " + total);
    container.appendChild(score);
  }

  window.LessonQuiz = { render: render };
})();
