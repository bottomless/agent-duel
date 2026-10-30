if (window.location.hash.startsWith("#offer=")) {
  window.location.replace(`/remote/${window.location.search}${window.location.hash}`);
}

const howDialog = document.getElementById("how-dialog");
const howButton = document.getElementById("how-it-works");

howButton.addEventListener("click", () => howDialog.showModal());
howDialog.addEventListener("click", (event) => {
  if (event.target !== howDialog) return;
  const bounds = howDialog.getBoundingClientRect();
  const outside =
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom;
  if (outside) howDialog.close();
});
