# 통합 테스트용 OpenSSH 서버 (CI와 로컬에서 같이 쓴다).
#   docker build -t sshbook-it-sshd .github/sshd
#   docker run -d --name sshbook-it -p 127.0.0.1:2222:22 sshbook-it-sshd
# 사용자 tester / 비밀번호 tester-pw. 테스트 전용이므로 실제 서버에 쓰지 않는다.
FROM alpine:3.20
RUN apk add --no-cache openssh openssh-sftp-server busybox-extras bash \
 && ssh-keygen -A \
 && adduser -D -s /bin/bash tester \
 && echo "tester:tester-pw" | chpasswd \
 && mkdir -p /srv/app && chown tester /srv/app
COPY sshd_config /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
