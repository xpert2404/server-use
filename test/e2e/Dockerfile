# sshd fixture for test/e2e/*.test.mjs. Test-only: fixed passwords and root password login.
#   docker build -t server-use-e2e test/e2e
#   docker run -d --init --name su-e2e -p 127.0.0.1:2222:22 server-use-e2e
# --init reaps the detached jobs server-use starts (they are reparented to PID 1).
FROM debian:bookworm-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      openssh-server cron util-linux sudo git python3 python3-venv curl procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# root: password login · alice: sudo asks for her password · bob: passwordless sudo.
# The drop-in is 10-*, so harden --lock-password's 00-server-use.conf wins (sshd keeps the first value).
# pam_loginuid fails without CAP_AUDIT_CONTROL and would kill every ssh session and cron run.
RUN echo 'root:root-pw' | chpasswd \
 && useradd -m -s /bin/bash -G sudo alice && echo 'alice:alice-pw' | chpasswd \
 && useradd -m -s /bin/bash bob && echo 'bob:bob-pw' | chpasswd \
 && echo 'bob ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bob && chmod 440 /etc/sudoers.d/bob \
 && printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/10-e2e.conf \
 && sed -i 's/^\(session\s\+\)required\(\s\+pam_loginuid\.so\)/\1optional\2/' /etc/pam.d/sshd /etc/pam.d/cron

EXPOSE 22
ENTRYPOINT ["sh", "-c", "ssh-keygen -A && mkdir -p /run/sshd && cron && exec /usr/sbin/sshd -D -e"]
