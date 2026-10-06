// Associate with the CloudFront default behavior as a viewer-request function.
// Rewrite only known app routes; asset and API failures retain their real status.
function handler(event) {
  var request = event.request;
  if (request.uri === "/" || /^\/incident\/[^/]+\/?$/.test(request.uri)) {
    request.uri = "/index.html";
  }
  return request;
}
if (typeof module !== "undefined") module.exports = { handler };
