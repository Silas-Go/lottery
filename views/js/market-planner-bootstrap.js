(function () {
    "use strict";

    var requestedExperiment = new URLSearchParams(window.location.search).get("experiment");
    if (requestedExperiment === "query" || requestedExperiment === "purchase") {
        document.documentElement.dataset.planner = requestedExperiment;
    }
}());
