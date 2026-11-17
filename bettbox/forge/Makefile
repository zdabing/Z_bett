# SPDX-License-Identifier: GPL-3.0
CC ?= cc
VENDOR_DIR ?= vendor
OUT ?= bettbox-forge
VERSION ?= 1.19.8

BASE_CFLAGS := -O2 -std=c11 -D_GNU_SOURCE
APP_CFLAGS := $(BASE_CFLAGS) $(CFLAGS) -Wall -Wextra -I$(VENDOR_DIR) -Isrc -DBETTBOX_FORGE_VERSION='"$(VERSION)"'
QJS_CFLAGS := $(BASE_CFLAGS) $(filter-out -Werror,$(CFLAGS)) -w -I$(VENDOR_DIR)
LDLIBS ?= -lm -lpthread

OBJS := main.o sandbox.o quickjs-amalgam.o

.PHONY: all clean

all: $(OUT)

$(OUT): $(OBJS)
	$(CC) $(LDFLAGS) -o $@ $(OBJS) $(LDLIBS)

main.o: src/main.c src/sandbox.h
	$(CC) $(APP_CFLAGS) -c $< -o $@

sandbox.o: src/sandbox.c src/sandbox.h $(VENDOR_DIR)/quickjs.h
	$(CC) $(APP_CFLAGS) -c $< -o $@

quickjs-amalgam.o: $(VENDOR_DIR)/quickjs-amalgam.c $(VENDOR_DIR)/quickjs.h
	$(CC) $(QJS_CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJS) $(OUT)
