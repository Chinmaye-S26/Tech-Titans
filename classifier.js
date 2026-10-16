// =====================================================================
// SHELL PHOTO CLASSIFIER (placeholder: NOT ACTIVE)
// ---------------------------------------------------------------------
// There is no trained coconut-shell model in this project yet, so the app
// does NOT guess a category from photos. Vendors choose the category
// themselves (manual review), and the photo stays on their phone.
//
// To activate a real classifier later (see README "Shell photo classifier"):
//   1. Collect 100+ labelled photos per category:
//        clean      = only tender coconut shells
//        mixed      = shells mixed with plastic or other waste
//        not-shells = no coconut shells in the photo
//   2. Train an image model (e.g. Google Teachable Machine -> Image project),
//      check its accuracy on photos it has not seen, export "TensorFlow.js".
//   3. Put model.json, metadata.json and weights.bin in a /model folder,
//      load @teachablemachine/image here, and set AVAILABLE = true only
//      after the model passes your validation test.
// =====================================================================

const Classifier = {
  AVAILABLE: false,
  CATEGORIES: [
    { id: "clean", label: "Clean tender coconut shells" },
    { id: "mixed", label: "Shells mixed with plastic or other waste" },
    { id: "unsure", label: "Not sure" },
  ],
  status: "AI shell classifier is not active: no trained coconut-shell model is installed. Please choose the category yourself.",
  async classify() { return null; },     // returns null until a validated model exists
};
