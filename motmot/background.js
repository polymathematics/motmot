

var contextMenuCreated = false;
console.log("Extension loaded!")

if (contextMenuCreated === false) {
chrome.contextMenus.create({
  id: "tweetOption",
  title: "Tweet This",
  contexts: ["selection"],
});
contextMenuCreated = true;
}



chrome.contextMenus.onClicked.addListener(function(info, tab) {

  if (info.menuItemId === "tweetOption") {
    var selectedText = info.selectionText;
    const motmotCredit = "This Tweet was sent by MotMot, the highlight to Tweet tool!";
    // set web intent url
    var tweetUrl = "http://www.twitter.com/intent/tweet?text=" + encodeURIComponent(selectedText) + '%0A' + "From: " + tab.url + "%0A" + "%0A" + motmotCredit;
    window.open(tweetUrl);
  }
});
