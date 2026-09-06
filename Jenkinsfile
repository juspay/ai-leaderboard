def pipeline_status = [
    SUCCESS_APP_PUSH      : false,
    SUCCESS_EXTENSION_PACK: false,
    BUILD_START_TIME      : '',
    BUILD_TIMESTAMP       : ''
]

pipeline {
    agent 'any'

    parameters {
        choice(
            name: 'BUILD_TARGET',
            choices: ['all', 'app', 'extension'],
            description: 'Choose what to build: app (Docker image), extension (zip artifact), or all.'
        )
        booleanParam(
            name: 'SKIP_TESTS',
            defaultValue: false,
            description: 'Skip the end-to-end test stage. Use only to ship a hotfix.'
        )
    }

    environment {
        GIT_SHORT_COMMIT = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()

        // Single registry: xyne-dev. grid-sbx serves production traffic, but
        // this app's images live in the dev project — no promotion, one tag.
        GCR_CREDENTIALS_ID = 'xyne-sbx-sa'
        APP_IMAGE_TAG      = "gcr.io/xyne-dev-461113/ai-leaderboard:${GIT_SHORT_COMMIT}"
    }

    stages {
        stage('Setup') {
            steps {
                script {
                    pipeline_status.BUILD_START_TIME = sh(script: 'date +%s | tr -d "\n"', returnStdout: true).trim()
                    pipeline_status.BUILD_TIMESTAMP = sh(script: 'date -u +"%Y-%m-%dT%H:%M:%SZ" | tr -d "\n"', returnStdout: true).trim()

                    echo "=== BUILD SETUP ==="
                    echo "Commit SHA: ${env.GIT_SHORT_COMMIT}"
                    echo "Target:     ${params.BUILD_TARGET}"
                }
            }
        }

        stage('Test') {
            when {
                allOf {
                    expression { !params.SKIP_TESTS }
                    anyOf {
                        expression { params.BUILD_TARGET == 'app' }
                        expression { params.BUILD_TARGET == 'all' }
                    }
                }
            }
            steps {
                script {
                    // Boot the real stack and run the e2e suite against it. The
                    // app image is built here anyway, so this costs one build.
                    try {
                        sh """
                            set -e
                            echo "=== E2E TESTS ==="
                            export APP_PORT=3999
                            docker compose up --build -d
                            for i in \$(seq 1 30); do
                                curl -fsS http://localhost:3999/api/data > /dev/null && break
                                sleep 2
                            done
                            docker run --rm --network host \
                                -v "\$(pwd)/test:/test:ro" \
                                -e API_BASE=http://localhost:3999 \
                                node:20-slim node /test/e2e.test.mjs
                        """
                    } finally {
                        sh 'docker compose down -v || true'
                    }
                }
            }
        }

        stage('GCR Login') {
            when {
                anyOf {
                    expression { params.BUILD_TARGET == 'app' }
                    expression { params.BUILD_TARGET == 'all' }
                }
            }
            steps {
                script {
                    withCredentials([
                        [$class: 'FileBinding',
                         credentialsId: env.GCR_CREDENTIALS_ID,
                         variable: 'GCR_KEY_PATH']
                    ]) {
                        sh """
                            set -e
                            echo "Authenticating with Google Cloud..."
                            gcloud auth activate-service-account --key-file=\${GCR_KEY_PATH}
                            gcloud auth configure-docker gcr.io
                            echo "GCR authentication complete."
                        """
                    }
                }
            }
        }

        stage('Build & Push App') {
            when {
                anyOf {
                    expression { params.BUILD_TARGET == 'app' }
                    expression { params.BUILD_TARGET == 'all' }
                }
            }
            steps {
                script {
                    try {
                        sh """
                            set -e
                            echo "=== BUILDING APP ==="
                            docker build -t ai-leaderboard .
                            docker tag ai-leaderboard ${env.APP_IMAGE_TAG}
                        """

                        withCredentials([
                            [$class: 'FileBinding',
                             credentialsId: env.GCR_CREDENTIALS_ID,
                             variable: 'GCR_KEY_PATH']
                        ]) {
                            sh """
                                set -e
                                gcloud auth activate-service-account --key-file=\${GCR_KEY_PATH}
                                docker push ${env.APP_IMAGE_TAG}
                            """
                        }

                        pipeline_status.SUCCESS_APP_PUSH = true
                        echo "App image pushed: ${env.APP_IMAGE_TAG}"

                    } catch (Exception e) {
                        error "App build or push failed: ${e.getMessage()}"
                    }
                }
            }
        }

        stage('Package Extension') {
            when {
                anyOf {
                    expression { params.BUILD_TARGET == 'extension' }
                    expression { params.BUILD_TARGET == 'all' }
                }
            }
            steps {
                script {
                    try {
                        def version = sh(
                            script: "grep '\"version\"' extension/manifest.json | head -1 | cut -d'\"' -f4",
                            returnStdout: true
                        ).trim()

                        sh """
                            set -e
                            echo "=== PACKAGING EXTENSION v${version} ==="
                            rm -f claude-usage-sync-*.zip
                            cd extension && zip -r ../claude-usage-sync-${version}-${env.GIT_SHORT_COMMIT}.zip . -x '.*' && cd ..
                        """

                        archiveArtifacts(
                            artifacts: "claude-usage-sync-${version}-${env.GIT_SHORT_COMMIT}.zip",
                            fingerprint: true
                        )

                        pipeline_status.SUCCESS_EXTENSION_PACK = true
                        echo "Extension packaged: claude-usage-sync-${version}-${env.GIT_SHORT_COMMIT}.zip"

                    } catch (Exception e) {
                        error "Extension packaging failed: ${e.getMessage()}"
                    }
                }
            }
        }

        stage('Build Summary') {
            when {
                expression { currentBuild.currentResult != 'ABORTED' }
            }
            steps {
                script {
                    def startTimeStr = pipeline_status.BUILD_START_TIME
                    def buildTimestamp = pipeline_status.BUILD_TIMESTAMP
                    def displayBranchName = env.BRANCH_NAME ?: 'unknown'
                    def app_succeeded = pipeline_status.SUCCESS_APP_PUSH
                    def ext_succeeded = pipeline_status.SUCCESS_EXTENSION_PACK

                    // --- FINAL FAILURE CHECK ---
                    def overall_success = true
                    if (params.BUILD_TARGET in ['app', 'all'] && !app_succeeded) {
                        overall_success = false
                    }
                    if (params.BUILD_TARGET in ['extension', 'all'] && !ext_succeeded) {
                        overall_success = false
                    }
                    if (!overall_success) {
                        error "Pipeline failed: targeted components did not build and push successfully."
                    }

                    def duration_minutes = '0.00'
                    if (startTimeStr && startTimeStr.isInteger()) {
                        def build_end_time = sh(script: 'date +%s | tr -d "\n"', returnStdout: true).trim().toInteger()
                        duration_minutes = String.format('%.2f', (build_end_time - startTimeStr.toInteger()) / 60.0)
                    }

                    echo """
========================================
           BUILD SUMMARY
========================================

• Build Target:    ${params.BUILD_TARGET}
• Commit SHA:      ${env.GIT_SHORT_COMMIT}
• Branch:          ${displayBranchName}
• Build Number:    ${env.BUILD_NUMBER}
• Build Duration:  ${duration_minutes} minutes
• Build Timestamp: ${buildTimestamp}
• Tests:           ${params.SKIP_TESTS ? 'SKIPPED' : 'run'}

${app_succeeded ? "APP:       ${env.APP_IMAGE_TAG}" : (params.BUILD_TARGET in ['app', 'all'] ? 'APP:       FAILED' : 'APP:       not targeted')}
${ext_succeeded ? 'EXTENSION: packaged, see archived artifacts' : (params.BUILD_TARGET in ['extension', 'all'] ? 'EXTENSION: FAILED' : 'EXTENSION: not targeted')}

DEPLOY (manual, as in grid-ai-onboarding — nothing auto-deploys):

  kubectl -n litellm set image deployment/leaderboard \\
      leaderboard=${env.APP_IMAGE_TAG}
  kubectl -n litellm rollout status deployment/leaderboard

  Note: the Deployment uses strategy Recreate, so expect a few seconds
  of downtime while the old pod releases the ReadWriteOnce volume.

========================================
"""

                    writeFile file: 'build-summary.json', text: """
{
  "build_info": {
    "target": "${params.BUILD_TARGET}",
    "commit_sha": "${env.GIT_SHORT_COMMIT}",
    "branch": "${displayBranchName}",
    "build_number": "${env.BUILD_NUMBER}",
    "duration_minutes": ${duration_minutes},
    "timestamp": "${buildTimestamp}",
    "tests_skipped": ${params.SKIP_TESTS}
  },
  "app": {
    "pushed": ${app_succeeded},
    "image_tag": "${env.APP_IMAGE_TAG}"
  },
  "extension": {
    "packaged": ${ext_succeeded}
  }
}
"""
                    archiveArtifacts artifacts: 'build-summary.json', fingerprint: true
                }
            }
        }
    }
}
