# Build image for the vibe-server native modules. AlmaLinux 8 carries glibc 2.28, the
# floor of the Node binary the server ships, so the modules load wherever that Node runs;
# gcc-toolset brings the C++20 compiler the Node headers need and links the newer
# libstdc++ parts statically, so the host's libstdc++ may be the stock one too.
FROM almalinux:8

ARG NODE_VERSION
ARG NODE_ARCH

RUN dnf install -y gcc-toolset-13-gcc gcc-toolset-13-gcc-c++ make python3.11 krb5-devel pkgconf-pkg-config xz binutils \
	&& dnf clean all

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
	| tar -xJ -C /usr/local --strip-components 1

ENV PATH=/opt/rh/gcc-toolset-13/root/usr/bin:$PATH
