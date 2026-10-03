/** BambooKit's public links (Help menu, feedback, docs). */
const WEB = "https://bambookit-web.onrender.com"
const REPO = "https://github.com/BambooKit/bambookit-application"

export const BAMBOOKIT_LINKS = {
  web: WEB,
  docs: `${WEB}/docs/`,
  modelsDocs: `${WEB}/docs/models/`,
  desktopDocs: `${WEB}/docs/desktop/`,
  // Release notes shown after an update; a missing file simply shows none.
  changelog: `${WEB}/changelog.json`,
  icon: `${WEB}/icon.png`,
  discussions: `${REPO}/discussions`,
  newIssue: `${REPO}/issues/new/choose`,
  featureRequest: `${REPO}/issues/new?template=feature_request.yml`,
  bugReport: `${REPO}/issues/new?template=bug_report.yml`,
} as const
