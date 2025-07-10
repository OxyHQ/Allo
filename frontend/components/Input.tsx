import React from "react";
import { TextInput } from "react-native-paper";
import { colors } from "@/constants/theme";
import { InputProps } from "@/types";

const Input = (props: InputProps) => {
  return (
    <TextInput
      mode="outlined"
      outlineColor={colors.neutral200}
      activeOutlineColor={colors.primary}
      textColor={colors.text}
      placeholderTextColor={colors.neutral400}
      style={{ backgroundColor: colors.neutral100 }}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder}
      secureTextEntry={props.secureTextEntry}
      keyboardType={props.keyboardType}
      autoCapitalize={props.autoCapitalize}
      autoComplete={props.autoComplete}
      ref={props.inputRef}
    />
  );
};

export default Input;
