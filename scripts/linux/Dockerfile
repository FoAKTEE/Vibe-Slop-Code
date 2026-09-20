# Build image for the desktop app's native modules. AlmaLinux 8 carries glibc 2.28, and
# gcc-toolset links the newer libstdc++ parts statically, so the modules stay at GLIBCXX
# 3.4.25: exactly the pair upstream's own linux client is built against (see
# build/azure-pipelines/linux/steps/product-build-linux-compile.yml, EXPECTED_GLIBC_VERSION
# 2.28 / EXPECTED_GLIBCXX_VERSION 3.4.25). The modules are compiled against the Electron
# headers that .npmrc names, so Node here is only the host for npm and node-gyp.
# libxkbfile/libX11 are what native-keymap needs and krb5 what kerberos needs - the same
# three -dev packages upstream installs (build/azure-pipelines/linux/product-build-linux-node-modules.yml).
FROM almalinux:8

ARG NODE_VERSION
ARG NODE_ARCH

RUN dnf install -y 'dnf-command(config-manager)' \
	&& dnf config-manager --set-enabled powertools \
	&& dnf install -y gcc-toolset-13-gcc gcc-toolset-13-gcc-c++ make python3.11 krb5-devel \
		libxkbfile-devel libX11-devel pkgconf-pkg-config xz binutils \
	&& dnf clean all

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
	| tar -xJ -C /usr/local --strip-components 1

ENV PATH=/opt/rh/gcc-toolset-13/root/usr/bin:$PATH
